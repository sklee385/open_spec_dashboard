// Toolhelp avoids taskkill's WMI dependency. No tool arguments are evaluated as PowerShell.
export function windowsProcessTreeScript(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  return `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class CliProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern bool Process32First(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern bool Process32Next(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Stop(int pid) {
    var snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1)) throw new Exception("Snapshot failed");
    var entries=new List<Entry>(); var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
    try { if(!Process32First(snapshot, ref entry)) throw new Exception("Enumeration failed"); do {entries.Add(entry);} while(Process32Next(snapshot, ref entry)); }
    finally {CloseHandle(snapshot);}
    StopChildren(pid,entries);
  }
  static void StopChildren(int pid, List<Entry> entries) {
    foreach(var entry in entries) if(entry.parent==pid) StopChildren((int)entry.pid,entries);
    try {using(var p=Process.GetProcessById(pid)) {p.Kill(); if(!p.WaitForExit(5000)) throw new Exception("Termination timeout");}}
    catch(ArgumentException) {} // Already exited.
  }
}
'@
try { [CliProcessTree]::Stop(${pid}); exit 0 } catch { exit 1 }
`;
}
