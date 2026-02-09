use windows::{
    core::*,
    Media::{SystemMediaTransportControls, MediaPlaybackType, MediaPlaybackStatus},
    Win32::Foundation::*,
    Win32::System::LibraryLoader::GetModuleHandleW,
    Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, LoadCursorW, PeekMessageW, PostQuitMessage, RegisterClassW,
        TranslateMessage, CW_USEDEFAULT, IDC_ARROW, MSG, PM_REMOVE, WINDOW_EX_STYLE, WM_DESTROY, WM_QUIT, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    },
    Win32::System::WinRT::ISystemMediaTransportControlsInterop,
};
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    unsafe {
        // Initialize COM as STA for UI thread
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)?;

        let instance = GetModuleHandleW(None)?;
        let class_name = w!("MockSpotifySessionClass");

        let wc = WNDCLASSW {
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hInstance: instance.into(),
            lpszClassName: class_name,
            lpfnWndProc: Some(wnd_proc),
            ..Default::default()
        };

        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class_name,
            w!("Mock Spotify Session"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            None,
            None,
            instance,
            None,
        );

        if hwnd.0 == 0 {
            return Err(Error::from_win32());
        }

        println!("Window created. HWND: {:?}", hwnd);

        // Get SMTC for the window using Interop
        let interop: ISystemMediaTransportControlsInterop = windows::core::factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        let controls: SystemMediaTransportControls = interop.GetForWindow(hwnd)?;

        println!("Got SystemMediaTransportControls.");

        // Configure SMTC
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsNextEnabled(true)?;
        controls.SetIsPreviousEnabled(true)?;
        controls.SetPlaybackStatus(MediaPlaybackStatus::Playing)?;
        
        // controls.SetDisplayUpdater(controls.DisplayUpdater()?)?; // Error: method not found, and not needed.

        let updater = controls.DisplayUpdater()?;
        updater.SetType(MediaPlaybackType::Music)?;
        
        let music_props = updater.MusicProperties()?;
        music_props.SetTitle(&HSTRING::from("Mock Title"))?;
        music_props.SetArtist(&HSTRING::from("Mock Artist"))?;
        
        updater.Update()?;

        println!("SMTC Updated: Playing 'Mock Title' by 'Mock Artist'");
        println!("Broadcasting... Press Ctrl+C to stop.");

        // Message loop
        let mut msg = MSG::default();
        let mut last_update = Instant::now();
        let mut counter = 0;

        loop {
            // Non-blocking peek message
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    return Ok(());
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            // Update every 3 seconds to simulate song change
            if last_update.elapsed() > Duration::from_secs(3) {
                counter += 1;
                let new_title = format!("Mock Title {}", counter);
                music_props.SetTitle(&HSTRING::from(&new_title))?;
                updater.Update()?;
                println!("Updated title to: {}", new_title);
                last_update = Instant::now();
            }

            // Small sleep to avoid CPU spinning
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

extern "system" fn wnd_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        match message {
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}
