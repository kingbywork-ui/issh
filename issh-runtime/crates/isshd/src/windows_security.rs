use std::ffi::c_void;
use std::io;
use std::mem::{size_of, size_of_val};
use std::ptr::{null_mut, NonNull};
use std::slice;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub struct PipeSecurityAttributes {
    descriptor: NonNull<c_void>,
    attributes: SECURITY_ATTRIBUTES,
}

impl PipeSecurityAttributes {
    pub fn for_current_user() -> io::Result<Self> {
        let user_sid = current_user_sid_string()?;
        let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;{user_sid})");
        let encoded: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();

        // SAFETY: `encoded` is a valid, null-terminated UTF-16 SDDL string.
        // The API allocates the returned descriptor with LocalAlloc.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                encoded.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }

        let descriptor = NonNull::new(descriptor).ok_or_else(io::Error::last_os_error)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.as_ptr(),
            bInheritHandle: 0,
        };

        Ok(Self {
            descriptor,
            attributes,
        })
    }

    pub fn as_mut_ptr(&mut self) -> *mut c_void {
        (&mut self.attributes as *mut SECURITY_ATTRIBUTES).cast()
    }
}

impl Drop for PipeSecurityAttributes {
    fn drop(&mut self) {
        // SAFETY: the descriptor was allocated by
        // ConvertStringSecurityDescriptorToSecurityDescriptorW and is owned by
        // this value.
        unsafe {
            LocalFree(self.descriptor.as_ptr());
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by OpenProcessToken and is owned by
        // this value.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn current_user_sid_string() -> io::Result<String> {
    let mut token = null_mut();
    // SAFETY: GetCurrentProcess returns a process pseudo-handle, and `token`
    // is a valid output pointer.
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle(token);

    let mut required_bytes = 0_u32;
    // SAFETY: the first call intentionally supplies a null buffer to obtain
    // the required size.
    unsafe {
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut required_bytes);
    }
    if required_bytes == 0 {
        return Err(io::Error::last_os_error());
    }

    let word_size = size_of::<usize>();
    let words = (required_bytes as usize).div_ceil(word_size);
    let mut buffer = vec![0_usize; words];
    // SAFETY: the buffer is aligned for TOKEN_USER and has the byte size
    // returned by the preceding GetTokenInformation call.
    let read = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size_of_val(buffer.as_slice()) as u32,
            &mut required_bytes,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }

    // SAFETY: GetTokenInformation populated the aligned buffer with a
    // TOKEN_USER structure whose SID remains valid while `buffer` is alive.
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid_text = null_mut();
    // SAFETY: TOKEN_USER contains a valid SID and `sid_text` is a valid output
    // pointer. The returned string is allocated with LocalAlloc.
    let converted = unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text) };
    if converted == 0 {
        return Err(io::Error::last_os_error());
    }
    let sid_text = NonNull::new(sid_text).ok_or_else(io::Error::last_os_error)?;

    // SAFETY: ConvertSidToStringSidW returns a null-terminated UTF-16 string.
    let length = unsafe {
        let mut length = 0;
        while *sid_text.as_ptr().add(length) != 0 {
            length += 1;
        }
        length
    };
    // SAFETY: `length` was determined by scanning the valid string up to its
    // null terminator.
    let text =
        String::from_utf16_lossy(unsafe { slice::from_raw_parts(sid_text.as_ptr(), length) });

    // SAFETY: the SID string was allocated by ConvertSidToStringSidW and is no
    // longer used after this call.
    unsafe {
        LocalFree(sid_text.as_ptr().cast());
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_security_attributes_are_constructed() {
        let mut security =
            PipeSecurityAttributes::for_current_user().expect("security descriptor should build");
        assert!(!security.as_mut_ptr().is_null());
    }
}
