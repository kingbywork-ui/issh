use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::fmt;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

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

pub const MAX_SFTP_CHUNK_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SftpReadChunk {
    pub offset: u64,
    pub data: Vec<u8>,
    pub total_size: u64,
    pub eof: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SftpWriteOutcome {
    pub total_size: u64,
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

    pub async fn read_file_chunk(
        &self,
        path: &str,
        offset: u64,
        length: usize,
    ) -> Result<SftpReadChunk, SftpError> {
        validate_path(path)?;
        if length > MAX_SFTP_CHUNK_BYTES {
            return Err(SftpError::FileTooLarge {
                limit: MAX_SFTP_CHUNK_BYTES,
            });
        }
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let total_size = metadata.size.unwrap_or(0);
        if total_size > MAX_SFTP_FILE_BYTES as u64 {
            return Err(SftpError::FileTooLarge {
                limit: MAX_SFTP_FILE_BYTES,
            });
        }
        if offset >= total_size {
            return Ok(SftpReadChunk {
                offset,
                data: Vec::new(),
                total_size,
                eof: true,
            });
        }
        let remaining = (total_size - offset) as usize;
        let take = remaining.min(length);
        let mut file = self
            .session
            .open(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let mut buffer = vec![0u8; take];
        let mut filled = 0usize;
        while filled < take {
            let read = file
                .read(&mut buffer[filled..])
                .await
                .map_err(|error| SftpError::Transfer(error.to_string()))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        buffer.truncate(filled);
        let eof = offset + filled as u64 >= total_size;
        Ok(SftpReadChunk {
            offset,
            data: buffer,
            total_size,
            eof,
        })
    }

    pub async fn write_file_chunk(
        &self,
        path: &str,
        offset: u64,
        data: &[u8],
        truncate: bool,
    ) -> Result<SftpWriteOutcome, SftpError> {
        validate_path(path)?;
        if data.len() > MAX_SFTP_CHUNK_BYTES {
            return Err(SftpError::FileTooLarge {
                limit: MAX_SFTP_CHUNK_BYTES,
            });
        }
        let flags = if truncate {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE
        };
        let mut file = self
            .session
            .open_with_flags(path, flags)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        if offset > 0 {
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|error| SftpError::Transfer(error.to_string()))?;
        }
        file.write_all(data)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let end = offset + data.len() as u64;
        file.flush()
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        file.close()
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let metadata = self
            .session
            .metadata(path)
            .await
            .map_err(|error| SftpError::Transfer(error.to_string()))?;
        let total_size = metadata.size.unwrap_or(end).max(end);
        Ok(SftpWriteOutcome { total_size })
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
