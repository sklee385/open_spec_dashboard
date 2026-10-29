$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.action -eq 'confirm') {
    Add-Type -AssemblyName System.Windows.Forms
    $answer = [System.Windows.Forms.MessageBox]::Show('Force close OpenSpecBoard and its owned work processes? Unsaved changes and running work may be lost. The next launch will use safe mode.', 'OpenSpecBoard Emergency Recovery', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('true') } else { [Console]::Out.Write('false') }
    exit 0
  }
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class EmergencyNative {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint low, high; }
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public IntPtr reserved1, peb, reserved2a, reserved2b, processId, inheritedFromProcessId;
  }
  public sealed class Identity { public int pid; public int parentPid; public string executablePath; public string createdAt; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr handle,ref Entry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr handle,ref Entry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle,uint flags,StringBuilder name,ref uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int informationClass,out BasicInformation information,int length,out int returnedLength);
  static Identity Read(IntPtr handle,int pid,int snapshotParent) {
    var name = new StringBuilder(32768); uint length = 32768; FileTime created,exited,kernel,user;
    if (!QueryFullProcessImageNameW(handle,0,name,ref length) || !GetProcessTimes(handle,out created,out exited,out kernel,out user)) return null;
    BasicInformation basic; int returnedLength;
    // Parent and identity must come from the same kernel object. A reused PID
    // must never inherit the old Toolhelp entry's ownership edge.
    if (NtQueryInformationProcess(handle,0,out basic,Marshal.SizeOf(typeof(BasicInformation)),out returnedLength) < 0) return null;
    long parent = basic.inheritedFromProcessId.ToInt64();
    if (parent < 0 || parent > Int32.MaxValue || (snapshotParent >= 0 && parent != snapshotParent)) return null;
    return new Identity { pid=pid,parentPid=(int)parent,executablePath=name.ToString(),createdAt=(((ulong)created.high << 32) | created.low).ToString(System.Globalization.CultureInfo.InvariantCulture) };
  }
  public static Identity[] Snapshot() {
    var result = new List<Identity>(); var snapshot = CreateToolhelp32Snapshot(2,0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception();
    try {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot,ref entry)) throw new Win32Exception();
      do {
        var handle = OpenProcess(0x1000,false,entry.pid);
        if (handle == IntPtr.Zero) { result.Add(new Identity { pid=(int)entry.pid,parentPid=(int)entry.parent }); continue; }
        try { var item = Read(handle,(int)entry.pid,(int)entry.parent); result.Add(item ?? new Identity { pid=(int)entry.pid,parentPid=(int)entry.parent }); }
        finally { CloseHandle(handle); }
      } while (Process32NextW(snapshot,ref entry));
      return result.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  public static bool Terminate(int pid,string path,string created) {
    if (pid <= 0 || (uint)pid == GetCurrentProcessId()) throw new InvalidOperationException("Protected process");
    // Keep this exact kernel handle open across identity validation and kill.
    var handle = OpenProcess(0x1000 | 0x0001 | 0x00100000,false,(uint)pid);
    if (handle == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() == 87) return false;
      throw new Win32Exception();
    }
    try {
      var item = Read(handle,pid,-1);
      if (item == null || item.createdAt != created || !String.Equals(item.executablePath,path,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Process identity changed");
      if (!TerminateProcess(handle,1)) throw new Win32Exception();
      if (WaitForSingleObject(handle,5000) != 0) throw new InvalidOperationException("Process termination not confirmed");
      return true;
    } finally { CloseHandle(handle); }
  }
}
"@
  if ($request.action -eq 'snapshot') {
    [Console]::Out.Write((ConvertTo-Json -InputObject @([EmergencyNative]::Snapshot()) -Compress -Depth 4))
  } elseif ($request.action -eq 'terminate') {
    $terminated = @()
    foreach ($identity in $request.identities) {
      if ([EmergencyNative]::Terminate([int]$identity.pid,[string]$identity.executablePath,[string]$identity.createdAt)) { $terminated += [int]$identity.pid }
    }
    [Console]::Out.Write((ConvertTo-Json -InputObject @($terminated) -Compress))
  } else { throw 'Unknown emergency operation' }
} catch {
  [Console]::Error.WriteLine('Emergency process identity verification or termination failed.')
  exit 1
}
