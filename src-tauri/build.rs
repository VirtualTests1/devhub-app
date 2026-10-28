// The application manifest is customised for one reason: `longPathAware`
// (r27-R1). Without it Windows keeps the 260-character MAX_PATH process rule
// even when the registry's LongPathsEnabled is on, and a repository whose
// checkout contains deep `node_modules` paths fails inside git with no useful
// sentence. `core.longpaths=true` is passed to every git invocation as well;
// the manifest is what lets the app's own file IO use the same long paths.
//
// The Common-Controls v6 dependency is copied from Tauri's default manifest:
// tauri-build's documentation warns that omitting it breaks the dialog APIs
// this app uses (confirmDestructive → plugin-dialog → native task dialog).
fn main() {
    #[cfg(windows)]
    let attributes = tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().app_manifest(
            r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#,
        ),
    );
    #[cfg(not(windows))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("tauri-build failed");
}
