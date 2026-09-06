fn main() {
    println!("cargo:rerun-if-env-changed=ROSTER_MAINCLOUD_URI");
    println!("cargo:rerun-if-env-changed=ROSTER_MAINCLOUD_DATABASE");
    tauri_build::build()
}
