use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
use windows::System::DispatcherQueueController;
use tokio::time::Duration;

fn main() {
    unsafe {
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
        RoInitialize(RO_INIT_MULTITHREADED).ok();
    }
    
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();

    rt.block_on(async {
        println!("RequestAsync called, awaiting...");
        match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => match op.await {
                Ok(manager) => {
                    println!("Manager obtained!");
                    let sessions = manager.GetSessions().unwrap();
                    println!("Sessions: {}", sessions.Size().unwrap());
                }
                Err(e) => println!("Error awaiting RequestAsync: {:?}", e),
            },
            Err(e) => println!("Error calling RequestAsync: {:?}", e),
        }
    });
}
