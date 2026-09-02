#[cfg(windows)]
mod platform {
    use std::ptr::{copy_nonoverlapping, null_mut};
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };

    const CF_UNICODETEXT: u32 = 13;

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    fn open_clipboard() -> Result<ClipboardGuard, String> {
        for _ in 0..5 {
            if unsafe { OpenClipboard(null_mut()) } != 0 {
                return Ok(ClipboardGuard);
            }
            thread::sleep(Duration::from_millis(10));
        }
        Err(format!(
            "无法打开系统剪贴板：{}",
            std::io::Error::last_os_error()
        ))
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);

        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * size_of::<u16>());
            if memory.is_null() {
                return Err("无法为系统剪贴板分配内存".to_string());
            }
            let target = GlobalLock(memory).cast::<u16>();
            if target.is_null() {
                GlobalFree(memory);
                return Err(format!(
                    "无法锁定系统剪贴板内存：{}",
                    std::io::Error::last_os_error()
                ));
            }
            copy_nonoverlapping(wide.as_ptr(), target, wide.len());
            GlobalUnlock(memory);

            let _guard = match open_clipboard() {
                Ok(guard) => guard,
                Err(error) => {
                    GlobalFree(memory);
                    return Err(error);
                }
            };
            if EmptyClipboard() == 0 {
                GlobalFree(memory);
                return Err(format!(
                    "无法清空系统剪贴板：{}",
                    std::io::Error::last_os_error()
                ));
            }

            if SetClipboardData(CF_UNICODETEXT, memory.cast::<core::ffi::c_void>()).is_null() {
                GlobalFree(memory);
                return Err(format!(
                    "无法写入系统剪贴板：{}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    pub fn read_text() -> Result<String, String> {
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
            return Ok(String::new());
        }

        let _guard = open_clipboard()?;
        unsafe {
            let handle: HANDLE = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() {
                return Err(format!(
                    "无法读取系统剪贴板：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let memory: HGLOBAL = handle.cast::<core::ffi::c_void>();
            let source = GlobalLock(memory).cast::<u16>();
            if source.is_null() {
                return Err(format!(
                    "无法锁定系统剪贴板内存：{}",
                    std::io::Error::last_os_error()
                ));
            }
            let capacity = GlobalSize(memory) / size_of::<u16>();
            let units = std::slice::from_raw_parts(source, capacity);
            let length = units.iter().position(|unit| *unit == 0).unwrap_or(capacity);
            let result = String::from_utf16(&units[..length])
                .map_err(|error| format!("系统剪贴板文本编码无效：{error}"));
            GlobalUnlock(memory);
            result
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn write_text(_text: &str) -> Result<(), String> {
        Err("当前平台暂不支持原生剪贴板".to_string())
    }

    pub fn read_text() -> Result<String, String> {
        Err("当前平台暂不支持原生剪贴板".to_string())
    }
}

pub use platform::{read_text, write_text};
