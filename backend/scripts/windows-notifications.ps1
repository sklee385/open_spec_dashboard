param([Parameter(Mandatory=$true)][ValidateSet('register','show','unregister')][string]$Action)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$appId = 'OpenSpecBoard.Notifications'
$marker = 'OpenSpecBoard.NativeNotifications.v1'
$key = 'HKCU:\Software\Classes\AppUserModelId\OpenSpecBoard.Notifications'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenSpecBoard Notifications.lnk'
try {
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'Interactive user session required' }
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OpenSpecShortcut {
  [StructLayout(LayoutKind.Sequential)] public struct Key { public Guid fmtid; public uint pid; public Key(uint id) { fmtid=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); pid=id; } }
  [StructLayout(LayoutKind.Explicit, Size=24)] public struct Value { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface Store { void GetCount(out uint count); void GetAt(uint i, out Key key); void GetValue(ref Key key, out Value value); void SetValue(ref Key key, ref Value value); void Commit(); }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind, uint flags, ref Guid iid, out Store store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
  public static string Read(string path) {
    Store store; Guid iid=typeof(Store).GUID; SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 0, ref iid, out store);
    try { var key=new Key(5); Value value; store.GetValue(ref key,out value); try { return value.vt==31 ? Marshal.PtrToStringUni(value.ptr) : null; } finally { PropVariantClear(ref value); } }
    finally { Marshal.ReleaseComObject(store); }
  }
  public static void Write(string path, string appId) {
    Store store; Guid iid=typeof(Store).GUID; SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
    try {
      var key=new Key(5); var value=new Value { vt=31, ptr=Marshal.StringToCoTaskMemUni(appId) };
      try { store.SetValue(ref key, ref value); } finally { PropVariantClear(ref value); }
      key=new Key(26); value=new Value { vt=72, ptr=Marshal.AllocCoTaskMem(16) };
      Marshal.StructureToPtr(new Guid("80DA4BF5-3E0A-41EE-9B3E-751EB0E7ABEA"), value.ptr, false);
      try { store.SetValue(ref key, ref value); } finally { PropVariantClear(ref value); }
      store.Commit();
    } finally { Marshal.ReleaseComObject(store); }
  }
}
'@
  if ($Action -eq 'register' -or $Action -eq 'unregister') {
    if ((Test-Path -LiteralPath $key) -and (Get-ItemProperty -LiteralPath $key).Owner -ne $marker) { throw 'Foreign registration' }
    if ((Test-Path -LiteralPath $shortcut) -and [OpenSpecShortcut]::Read($shortcut) -ne $appId) { throw 'Foreign shortcut' }
    if ($Action -eq 'unregister') {
      if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
      if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key }
    } else {
      $url = [Uri]$data.dashboardUrl
      if (-not $url.IsAbsoluteUri -or $url.Scheme -notin @('http','https') -or $url.Host -notin @('localhost','127.0.0.1','[::1]','::1') -or $url.UserInfo -or $url.Query -or $url.Fragment) { throw 'Invalid dashboard URL' }
      New-Item -Path $key -Force | Out-Null
      New-ItemProperty -LiteralPath $key -Name Owner -Value $marker -PropertyType String -Force | Out-Null
      New-ItemProperty -LiteralPath $key -Name DisplayName -Value 'OpenSpecBoard' -PropertyType String -Force | Out-Null
      $shell = New-Object -ComObject WScript.Shell
      try {
        $link = $shell.CreateShortcut($shortcut)
        $link.TargetPath = Join-Path $env:SystemRoot 'explorer.exe'
        $link.Arguments = '"microsoft-edge:' + $url.AbsoluteUri + '"'
        $link.Description = 'OpenSpecBoard notifications'
        $link.Save()
        [OpenSpecShortcut]::Write($shortcut, $appId)
      } finally { if ($link) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($link) }; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
    }
  } else {
    if (-not (Test-Path -LiteralPath $key) -or (Get-ItemProperty -LiteralPath $key).Owner -ne $marker -or -not (Test-Path -LiteralPath $shortcut) -or [OpenSpecShortcut]::Read($shortcut) -ne $appId) { throw 'Registration missing' }
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml([string]$data.xml)
    $toastElement = $xml.DocumentElement
    if ($toastElement.NodeName -ne 'toast' -or $toastElement.GetAttribute('activationType') -ne 'protocol' -or $toastElement.GetAttribute('launch') -ne $data.url -or -not ([string]$data.url).StartsWith('microsoft-edge:')) { throw 'Invalid toast' }
    $target = [Uri](([string]$data.url).Substring(15))
    if ($target.Scheme -notin @('http','https') -or $target.Host -notin @('localhost','127.0.0.1','[::1]','::1') -or $target.UserInfo -or $target.Fragment) { throw 'Invalid target' }
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
    if ([int]$notifier.Setting -ne 0) { throw 'Windows notifications disabled' }
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier.Show($toast)
  }
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}
