using System;
using System.Runtime.InteropServices;

// A supervisor outside the worker's job owns the only job handle. A worker or
// host crash therefore terminates every descendant without PID/name guessing.
public static class BrowserGuard {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic BasicLimitInformation; public Counters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero, process=IntPtr.Zero, parent=IntPtr.Zero, buffer=IntPtr.Zero;
    try {
      uint owner, host;
      if(args.Length!=2 || !uint.TryParse(args[0], out owner) || !uint.TryParse(args[1], out host) || owner==0 || host==0) return 2;
      job=CreateJobObject(IntPtr.Zero, null);
      if(job==IntPtr.Zero) throw new Exception("job create failed");
      Extended info=new Extended(); info.BasicLimitInformation.LimitFlags=0x2000;
      buffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended))); Marshal.StructureToPtr(info, buffer, false);
      if(!SetInformationJobObject(job, 9, buffer, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Exception("job policy failed");
      process=OpenProcess(0x00100101, false, owner); parent=OpenProcess(0x00100000, false, host);
      if(process==IntPtr.Zero || parent==IntPtr.Zero || !AssignProcessToJobObject(job, process)) throw new Exception("job assignment failed");
      Console.WriteLine("READY"); Console.Out.Flush();
      if(WaitForMultipleObjects(2, new IntPtr[]{ process, parent }, false, 0xffffffff)==0xffffffff) throw new Exception("job wait failed");
      return 0;
    } catch { Console.Error.WriteLine("browser process ownership failed: " + Marshal.GetLastWin32Error()); return 1; }
    finally {
      if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(process!=IntPtr.Zero) CloseHandle(process);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
    }
  }
}
