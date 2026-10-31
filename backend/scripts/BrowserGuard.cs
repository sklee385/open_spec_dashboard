using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;

// A supervisor outside the worker's job owns the only job handle. A worker or
// host crash therefore terminates every descendant without PID/name guessing.
public static class BrowserGuard {
  static int stopRequested=0;
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
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out Accounting data, uint length, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void WriteWitness(FileStream stream,string state,string nonce,uint worker) {
    byte[] bytes=Encoding.UTF8.GetBytes(state+"\n"+nonce+"\n"+worker+"\n"+System.Diagnostics.Process.GetCurrentProcess().Id+"\n"+DateTime.UtcNow.ToString("o")+"\n");
    stream.Position=0; stream.SetLength(0); stream.Write(bytes,0,bytes.Length); stream.Flush(true);
  }
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero, process=IntPtr.Zero, parent=IntPtr.Zero, buffer=IntPtr.Zero;
    FileStream witness=null; string witnessNonce=null; bool assigned=false;
    FileStream head=null; bool pinned=false, browserJob=false, handleProof=false; string handleNonce=null; int result=1; uint owner=0, host=0;
    try {
      if(args.Length>=4 && args[0]=="HANDLE-PROOF-V1") {
        handleProof=true;handleNonce=args[1];if(!System.Text.RegularExpressions.Regex.IsMatch(handleNonce,"\\A[a-f0-9]{64}\\z"))return 2;
        string[] request=new string[args.Length-2];Array.Copy(args,2,request,0,request.Length);args=request;
      }
      browserJob=(args.Length==3 || args.Length==5) && args[2]=="BROWSER-JOB-V2";
      if((args.Length!=2 && args.Length!=4 && !browserJob) || !uint.TryParse(args[0], out owner) || !uint.TryParse(args[1], out host) || owner==0 || host==0) return 2;
      if(browserJob && args.Length==5) {
        if(!Path.IsPathRooted(args[3]) || args[4].Length!=64 || !System.Text.RegularExpressions.Regex.IsMatch(args[4], "\\A[a-f0-9]{64}\\z")) throw new Exception("witness request failed");
        witnessNonce=args[4]; witness=new FileStream(args[3],FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read);
      }
      job=CreateJobObject(IntPtr.Zero, null);
      if(job==IntPtr.Zero) throw new Exception("job create failed");
      Extended info=new Extended(); info.BasicLimitInformation.LimitFlags=0x2000;
      buffer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended))); Marshal.StructureToPtr(info, buffer, false);
      if(!SetInformationJobObject(job, 9, buffer, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Exception("job policy failed");
      process=OpenProcess(0x00100101, false, owner); if(!handleProof)parent=OpenProcess(0x00100000, false, host);
      if(process==IntPtr.Zero || !handleProof && parent==IntPtr.Zero)throw new Exception("process handle failed");
      if(handleProof){Console.WriteLine("BOUND HANDLE-PROOF-V1 "+handleNonce);Console.Out.Flush();if(Console.ReadLine()!="ASSIGN HANDLE-PROOF-V1 "+handleNonce)throw new Exception("process identity authorization failed");}
      if(!AssignProcessToJobObject(job,process))throw new Exception("job assignment failed");
      assigned=true;
      if(witness!=null) WriteWitness(witness,"READY",witnessNonce,owner);
      if(args.Length==4) {
        if(!Path.IsPathRooted(args[2]) || !args[3].StartsWith("refs/heads/") || args[3].IndexOfAny(new char[]{'\0','\r','\n'})>=0) throw new Exception("head request failed");
        head=new FileStream(args[2], FileMode.Open, FileAccess.Read, FileShare.Read);
        if(head.Length>1024) throw new Exception("head length failed");
        byte[] bytes=new byte[(int)head.Length]; int offset=0, count;
        while(offset<bytes.Length && (count=head.Read(bytes, offset, bytes.Length-offset))>0) offset+=count;
        if(offset!=bytes.Length || Encoding.UTF8.GetString(bytes).Trim()!="ref: "+args[3]) throw new Exception("head ref changed");
        pinned=true;
      }
      if(handleProof){Console.WriteLine("READY HANDLE-PROOF-V1");Console.Out.Flush();}
      Console.WriteLine(browserJob ? "READY BROWSER-JOB-V2" : pinned ? "READY HEAD-PIN-V1" : "READY"); Console.Out.Flush();
      if(browserJob || handleProof) {
        Thread input=new Thread(delegate() { try { string line; while((line=Console.ReadLine())!=null) if(line=="STOP BROWSER-JOB-V2" || line=="STOP HANDLE-PROOF-V1") { Interlocked.Exchange(ref stopRequested,1); return; } Interlocked.Exchange(ref stopRequested,1); } catch { Interlocked.Exchange(ref stopRequested,1); } }); input.IsBackground=true; input.Start();
        while(Interlocked.CompareExchange(ref stopRequested,0,0)==0) { uint wait=WaitForMultipleObjects(handleProof ? 1U : 2U,handleProof ? new IntPtr[]{process} : new IntPtr[]{process,parent},false,100); if(wait==0xffffffff) throw new Exception("job wait failed"); if(wait!=258) break; }
      } else if(WaitForMultipleObjects(2, new IntPtr[]{ process, parent }, false, 0xffffffff)==0xffffffff) throw new Exception("job wait failed");
      result=0;
    } catch { Console.Error.WriteLine("browser process ownership failed: " + Marshal.GetLastWin32Error()); result=1; }
    finally {
      if(job!=IntPtr.Zero) {
        // Closing the job handle only schedules termination. Keep HEAD pinned until
        // the kernel confirms every assigned descendant has actually terminated.
        TerminateJobObject(job, 1);
        Accounting accounting;
        if(browserJob) {
          DateTime deadline=DateTime.UtcNow.AddSeconds(10); bool quiescent=false;
          while(DateTime.UtcNow<deadline) { if(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero) && accounting.ActiveProcesses==0) { quiescent=true; break; } Thread.Sleep(10); }
          if(quiescent && assigned && result==0) { if(witness!=null) WriteWitness(witness,"QUIESCENT",witnessNonce,owner); try { Console.WriteLine("QUIESCENT BROWSER-JOB-V2"); Console.Out.Flush(); } catch { /* Host pipe may already be closed; the witness is durable. */ } } else result=1;
        } else while(!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) || accounting.ActiveProcesses!=0) Thread.Sleep(10);
      }
      if(head!=null) {
        if(pinned) { Console.WriteLine("QUIESCENT HEAD-PIN-V1"); Console.Out.Flush(); }
        head.Dispose();
      }
      if(witness!=null) witness.Dispose();
      if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(process!=IntPtr.Zero) CloseHandle(process);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
    }
    return result;
  }
}
