use std::{collections::HashMap, sync::Arc};
pub struct Icons {
    cache: tokio::sync::Mutex<HashMap<String, Option<String>>>,
    gate: Arc<tokio::sync::Semaphore>,
}
impl Default for Icons {
    fn default() -> Self {
        Self {
            cache: Default::default(),
            gate: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
#[tauri::command]
pub async fn app_icon(
    index: tauri::State<'_, crate::platform::AppIndex>,
    icons: tauri::State<'_, Icons>,
    id: String,
) -> Result<Option<String>, String> {
    if !index
        .0
        .lock()
        .await
        .as_ref()
        .is_some_and(|apps| apps.iter().any(|a| a.id == id))
    {
        return Err("App is not in the local index".into());
    }
    if let Some(icon) = icons.cache.lock().await.get(&id).cloned() {
        return Ok(icon);
    }
    let permit = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        icons.gate.clone().acquire_owned(),
    )
    .await
    .map_err(|_| "Icon extraction is busy".to_string())?
    .map_err(|e| e.to_string())?;
    let name = id.clone();
    let work = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        extract(&name).ok()
    });
    let icon = tokio::time::timeout(std::time::Duration::from_secs(2), work)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    let mut cache = icons.cache.lock().await;
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(id, icon.clone());
    Ok(icon)
}
#[cfg(not(windows))]
fn extract(_: &str) -> Result<String, String> {
    Err("Windows icons are unavailable".into())
}
#[cfg(windows)]
fn extract(id: &str) -> Result<String, String> {
    use base64::Engine;
    use windows::{
        core::PCWSTR,
        Win32::{Foundation::SIZE, Graphics::Gdi::*, System::Com::*, UI::Shell::*},
    };
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _com = Com;
        let name: Vec<u16> = format!("shell:AppsFolder\\{id}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None).map_err(|e| e.to_string())?;
        let bitmap = item
            .GetImage(SIZE { cx: 48, cy: 48 }, SIIGBF_ICONONLY)
            .map_err(|e| e.to_string())?;
        struct Bitmap(HBITMAP);
        impl Drop for Bitmap {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteObject(self.0.into());
                }
            }
        }
        let _bitmap = Bitmap(bitmap);
        let mut meta = BITMAP::default();
        if GetObjectW(
            bitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut meta as *mut BITMAP).cast()),
        ) == 0
        {
            return Err("Invalid icon bitmap".into());
        }
        if meta.bmWidth <= 0 || meta.bmHeight <= 0 || meta.bmWidth > 256 || meta.bmHeight > 256 {
            return Err("Invalid icon size".into());
        }
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return Err("Could not read icon".into());
        }
        struct Dc(HDC);
        impl Drop for Dc {
            fn drop(&mut self) {
                unsafe {
                    let _ = DeleteDC(self.0);
                }
            }
        }
        let _dc = Dc(dc);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: meta.bmWidth,
                biHeight: -meta.bmHeight,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (meta.bmWidth * meta.bmHeight * 4) as usize];
        if GetDIBits(
            dc,
            bitmap,
            0,
            meta.bmHeight as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        ) != meta.bmHeight
        {
            return Err("Could not decode icon".into());
        }
        let opaque = pixels.chunks_exact(4).all(|p| p[3] == 0);
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            if opaque {
                pixel[3] = 255;
            } else if pixel[3] > 0 {
                for c in 0..3 {
                    pixel[c] = ((pixel[c] as u32 * 255 / pixel[3] as u32).min(255)) as u8;
                }
            }
        }
        let mut bytes = Vec::new();
        {
            let mut encoder =
                png::Encoder::new(&mut bytes, meta.bmWidth as u32, meta.bmHeight as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
            writer
                .write_image_data(&pixels)
                .map_err(|e| e.to_string())?;
        }
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}
#[cfg(all(test, windows))]
mod tests {
    #[test]
    #[ignore = "reads the installed Windows Notepad icon from the Shell"]
    fn installed_notepad_icon() {
        let icon = super::extract("Microsoft.WindowsNotepad_8wekyb3d8bbwe!App").unwrap();
        assert!(icon.starts_with("data:image/png;base64,iVBOR"));
        assert!(icon.len() > 200);
    }
}
