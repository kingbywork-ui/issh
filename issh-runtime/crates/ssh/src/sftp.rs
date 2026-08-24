use russh_sftp::client::SftpSession;
use std::fmt;
use tokio::io::AsyncWriteExt;

pub const MAX_SFTP_PATH_BYTES: usize = 4096;
pub const MAX_SFTP_FILE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SFTP_DIR_ENTRIES: usize = 4096;
pub const SFTP_SUBSYSTEM_NAME: &str = "sftp";

#[derive(Debug)]
pub enum SftpError {
    InvalidPath,
    FileTooLarge { limit: usize },
    TooManyEntries { limit: usize },
    Channel(String),
    Transfer(String),
    Closed,
}

impl fmt::Display for SftpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => {
                formatter.write_str("SFTP path must be absolute and <= 4096 bytes")
            }
            Self::FileTooLarge { limit } => {
                write!(formatter, "SFTP payload exceeds {limit} bytes")
            }
            Self::TooManyEntries { limit } => {
                write!(formatter, "SFTP directory listing exceeds {limit} entries")
            }
            Self::Channel(message) => write!(formatter, "SFTP channel error: {message}"),
            Self::Transfer(message) => write!(formatter, "SFTP transfer error: {message}"),
            Self::Closed => formatter.write_str("SFTP session is closed"),
        }
    }
}

impl std::error::Error for SftpError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_unix_secs: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SftpFileStat {
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_unix_secs: Option<u64>,
}

pub struct SshSftpSession {
    session: SftpSession,
}

impl SshSftpSession {
    pub(crate) fn from_session(session: SftpSession) -> Self {
        Self { session }
    }

    pub async fn close(&self) -> Result<(), SftpError> {
        self.session
            .close()
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }

    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>, SftpError> {
        validate_path(path)?;
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let size = metadata.size.unwrap_or(0);
        if size > MAX_SFTP_FILE_BYTES as u64 {
            return Err(SftpError::FileTooLarge {
                limit: MAX_SFTP_FILE_BYTES,
            });
        }
        self.session
            .read(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }

    pub async fn write_file(&self, path: &str, data: &[u8]) -> Result<(), SftpError> {
        validate_path(path)?;
        if data.len() > MAX_SFTP_FILE_BYTES {
            return Err(SftpError::FileTooLarge {
                limit: MAX_SFTP_FILE_BYTES,
            });
        }
        let mut file = self
            .session
            .create(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        file.write_all(data)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        file.close()
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        Ok(())
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<SftpEntry>, SftpError> {
        validate_path(path)?;
        let read_dir = self
            .session
            .read_dir(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let mut entries = Vec::new();
        for entry in read_dir {
            if entries.len() >= MAX_SFTP_DIR_ENTRIES {
                return Err(SftpError::TooManyEntries {
                    limit: MAX_SFTP_DIR_ENTRIES,
                });
            }
            let metadata = entry.metadata();
            let file_type = metadata.file_type();
            entries.push(SftpEntry {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: file_type.is_dir(),
                is_file: file_type.is_file(),
                is_symlink: file_type.is_symlink(),
                size: metadata.size.unwrap_or(0),
                modified_unix_secs: metadata.mtime.map(|value| value as u64),
            });
        }
        Ok(entries)
    }

    pub async fn stat(&self, path: &str) -> Result<SftpFileStat, SftpError> {
        validate_path(path)?;
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let file_type = metadata.file_type();
        Ok(SftpFileStat {
            path: path.to_string(),
            is_dir: file_type.is_dir(),
            is_file: file_type.is_file(),
            is_symlink: file_type.is_symlink(),
            size: metadata.size.unwrap_or(0),
            modified_unix_secs: metadata.mtime.map(|value| value as u64),
        })
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), SftpError> {
        validate_path(path)?;
        self.session
            .create_dir(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }

    pub async fn remove_file(&self, path: &str) -> Result<(), SftpError> {
        validate_path(path)?;
        self.session
            .remove_file(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }

    pub async fn remove_dir(&self, path: &str) -> Result<(), SftpError> {
        validate_path(path)?;
        self.session
            .remove_dir(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }

    pub async fn rename(&self, old_path: &str, new_path: &str) -> Result<(), SftpError> {
        validate_path(old_path)?;
        validate_path(new_path)?;
        self.session
            .rename(old_path, new_path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))
    }
}

pub(crate) fn validate_path(path: &str) -> Result<(), SftpError> {
    if path.is_empty() || !path.starts_with('/') || path.len() > MAX_SFTP_PATH_BYTES {
        return Err(SftpError::InvalidPath);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_paths() {
        assert!(validate_path("/home").is_ok());
        assert!(validate_path("/").is_ok());
        assert!(validate_path("").is_err());
        assert!(validate_path("home").is_err());
        assert!(validate_path("./home").is_err());
        let long_path = format!("/{}", "a".repeat(MAX_SFTP_PATH_BYTES));
        assert!(validate_path(&long_path).is_err());
    }
}
