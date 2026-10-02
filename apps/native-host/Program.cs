using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

internal record TaskSpec(string Executable, string Cwd, string[] Arguments, Dictionary<string,string> Environment, string SessionId, string Question, string Mode);
internal static class Program
{
    const long MaxTranscriptBytes = 32L * 1024 * 1024;
    const int MaxTranscriptLineChars = 2 * 1024 * 1024;
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AllocConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int kind, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);

    static int Main(string[] args)
    {
        string? taskDirectory = null;
        try {
            if (args.Length == 2 && args[0] == "--collect") {
                var dir = Path.GetFullPath(args[1]);
                Console.InputEncoding = new System.Text.UTF8Encoding(false);
                var input = Console.In.ReadToEnd();
                if (input.Length > 1024 * 1024) throw new Exception("Stop hook payload is too large");
                using var doc = JsonDocument.Parse(input);
                if (doc.RootElement.GetProperty("hook_event_name").GetString() == "Stop")
                    File.WriteAllText(Path.Combine(dir, "stop.json"), input);
                return 0; // Observe the Stop event without changing another hook's decision.
            }
            if (args.Length != 2 || args[0] != "--task") throw new Exception("Expected structured --task file");
            var taskPath = Path.GetFullPath(args[1]);
            var dirPath = Path.GetDirectoryName(taskPath)!;
            taskDirectory = dirPath;
            var task = JsonSerializer.Deserialize<TaskSpec>(File.ReadAllText(taskPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? throw new Exception("Invalid task");
            if (!Guid.TryParse(task.SessionId, out _) || !Path.IsPathFullyQualified(task.Executable) || !Path.IsPathFullyQualified(task.Cwd)) throw new Exception("Invalid task paths/session");
            if (task.Mode is not ("hidden" or "visible")) throw new Exception("Invalid execution mode");
            bool hidden = task.Mode == "hidden";
            if (!hidden) AttachTerminal();
            using var job = new Job();
            var start = new ProcessStartInfo(task.Executable) { WorkingDirectory = task.Cwd, UseShellExecute = false };
            foreach (var arg in task.Arguments) start.ArgumentList.Add(arg);
            start.Environment.Clear(); foreach (var pair in task.Environment) start.Environment[pair.Key] = pair.Value;
            using var inputPipe = hidden ? new System.IO.Pipes.AnonymousPipeServerStream(System.IO.Pipes.PipeDirection.Out,HandleInheritability.Inheritable) : null;
            using var outputPipe = hidden ? new System.IO.Pipes.AnonymousPipeServerStream(System.IO.Pipes.PipeDirection.In,HandleInheritability.Inheritable) : null;
            using var errorPipe = hidden ? new System.IO.Pipes.AnonymousPipeServerStream(System.IO.Pipes.PipeDirection.In,HandleInheritability.Inheritable) : null;
            using var child = job.StartSuspended(start, inputPipe?.ClientSafePipeHandle.DangerousGetHandle() ?? IntPtr.Zero,outputPipe?.ClientSafePipeHandle.DangerousGetHandle() ?? IntPtr.Zero,errorPipe?.ClientSafePipeHandle.DangerousGetHandle() ?? IntPtr.Zero,hidden);
            inputPipe?.DisposeLocalCopyOfClientHandle(); outputPipe?.DisposeLocalCopyOfClientHandle(); errorPipe?.DisposeLocalCopyOfClientHandle();
            using var cancel = new CancellationTokenSource();
            var watcher = System.Threading.Tasks.Task.Run(async () => { while (!cancel.IsCancellationRequested) { if (File.Exists(Path.Combine(dirPath,"cancel"))) { job.Terminate(); return; } await System.Threading.Tasks.Task.Delay(100); } });
            try {
                if (hidden) {
                    var output = outputPipe!.CopyToAsync(Console.OpenStandardOutput());
                    var error = errorPipe!.CopyToAsync(Console.OpenStandardError());
                    using (var writer = new StreamWriter(inputPipe!,new System.Text.UTF8Encoding(false),1024,true)) { writer.Write(task.Question); }
                    inputPipe!.Dispose();
                    child.WaitForExit(); int exitCode = child.ExitCode; cancel.Cancel(); watcher.GetAwaiter().GetResult();
                    job.Terminate(); System.Threading.Tasks.Task.WaitAll(output,error);
                    return exitCode;
                }
                child.WaitForExit(); int visibleExitCode = child.ExitCode; cancel.Cancel(); watcher.GetAwaiter().GetResult();
                job.Terminate();
                if (File.Exists(Path.Combine(dirPath,"cancel"))) throw new Exception("Claude terminal was cancelled or timed out");
                if (visibleExitCode != 0) throw new Exception($"Claude terminal exited with code {visibleExitCode}");
                var answer = ValidateVisibleResult(dirPath, task);
                File.WriteAllText(Path.Combine(dirPath,"result.json"), JsonSerializer.Serialize(new { answer, sessionId=task.SessionId, exitCode=0 }));
                return 0;
            } finally {
                cancel.Cancel();
                try { watcher.GetAwaiter().GetResult(); } catch { /* Do not hide the primary process error. */ }
            }
        } catch (Exception error) {
            if (taskDirectory != null) { try { File.WriteAllText(Path.Combine(taskDirectory, "error.txt"), error.Message); } catch { /* Preserve the original error if diagnostics cannot be written. */ } }
            Console.Error.WriteLine(error.Message); return 1;
        }
    }

    static void AttachTerminal()
    {
        if (!AllocConsole() && Marshal.GetLastWin32Error() != 5) throw new Exception("Cannot open Claude terminal");
        var input = CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
        var output = CreateFile("CONOUT$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
        if (input == new IntPtr(-1) || output == new IntPtr(-1) || !SetHandleInformation(input,1,1) || !SetHandleInformation(output,1,1) || !SetStdHandle(-10,input) || !SetStdHandle(-11,output) || !SetStdHandle(-12,output))
            throw new Exception("Cannot attach Claude terminal input/output");
        Console.Title = "沐雨橙风 · Claude 对话（回答完成后输入 /exit）";
    }

    static string ValidateVisibleResult(string dirPath, TaskSpec task)
    {
        var stopPath = Path.Combine(dirPath,"stop.json");
        if (!File.Exists(stopPath) || new FileInfo(stopPath).Length > 1024 * 1024) throw new Exception("Claude did not produce a valid completed turn");
        using var stop = JsonDocument.Parse(File.ReadAllText(stopPath));
        var hook = stop.RootElement;
        if (hook.GetProperty("session_id").GetString() != task.SessionId) throw new Exception("Stop session mismatch");
        var transcript = Path.GetFullPath(hook.GetProperty("transcript_path").GetString() ?? "");
        if (Path.GetFileNameWithoutExtension(transcript) != task.SessionId || !File.Exists(transcript)) throw new Exception("Transcript session mismatch");
        if (new FileInfo(transcript).Length > MaxTranscriptBytes) throw new Exception("Claude transcript is too large");
        string? final = null; bool questionSeen = false; bool pending = false; bool exitSeen = false;
        foreach (var line in File.ReadLines(transcript)) {
            if (line.Length > MaxTranscriptLineChars) throw new Exception("Claude transcript line is too large");
            using var entry = JsonDocument.Parse(line); var row = entry.RootElement;
            if (row.TryGetProperty("sessionId",out var sid) && sid.GetString() != task.SessionId) throw new Exception("Transcript foreign session");
            var kind = row.TryGetProperty("type",out var rowType) ? rowType.GetString() : null;
            if (questionSeen && kind == "system" && row.TryGetProperty("subtype",out var subtype) && subtype.GetString() == "stop_hook_summary" && row.TryGetProperty("preventedContinuation",out var prevented) && prevented.ValueKind == JsonValueKind.True) {
                final = null; pending = true; continue;
            }
            if (questionSeen && ((row.TryGetProperty("isApiErrorMessage",out var apiError) && apiError.ValueKind == JsonValueKind.True) || (row.TryGetProperty("interruptedMessageId",out var interrupted) && interrupted.ValueKind != JsonValueKind.Null) || (kind == "system" && row.TryGetProperty("subtype",out var systemSubtype) && systemSubtype.GetString() == "error")))
                throw new Exception("Turn interrupted or failed");
            if (!row.TryGetProperty("type",out var type) || !row.TryGetProperty("message",out var message)) continue;
            if (type.GetString() == "user") {
                var content = message.GetProperty("content");
                var text = content.ValueKind == JsonValueKind.String ? content.GetString() : string.Join("\n",content.EnumerateArray().Where(x=>x.TryGetProperty("type",out var t)&&t.GetString()=="text").Select(x=>x.GetProperty("text").GetString()));
                var metadata = row.TryGetProperty("isMeta",out var meta) && meta.ValueKind == JsonValueKind.True;
                var toolResult = content.ValueKind == JsonValueKind.Array && content.GetArrayLength()>0 && content.EnumerateArray().All(x=>x.TryGetProperty("type",out var blockType) && blockType.GetString()=="tool_result");
                if (!questionSeen && text == task.Question) { questionSeen = true; final = null; pending = true; }
                else if (questionSeen && text == "[Request interrupted by user]") throw new Exception("Turn interrupted or failed");
                else if (questionSeen && !pending && !string.IsNullOrWhiteSpace(final) && IsExitCommand(text)) exitSeen = true;
                else if (questionSeen && exitSeen && IsExitOutput(text)) { }
                else if (questionSeen && !metadata && !toolResult)
                    throw new Exception("Additional user turn is not the requested business question");
            } else if (type.GetString() == "assistant" && questionSeen) {
                if (exitSeen) throw new Exception("Additional assistant turn after /exit");
                var blocks = message.GetProperty("content").EnumerateArray().ToArray();
                pending = blocks.Any(x=>x.GetProperty("type").GetString()=="tool_use");
                final = string.Join("\n",blocks.Where(x=>x.GetProperty("type").GetString()=="text").Select(x=>x.GetProperty("text").GetString()));
                if (!message.TryGetProperty("stop_reason",out var reason) || reason.GetString() != "end_turn") pending = true;
            }
        }
        if (!questionSeen || !exitSeen || pending || string.IsNullOrWhiteSpace(final) || final != hook.GetProperty("last_assistant_message").GetString()) throw new Exception("No verified complete assistant answer; finish the turn, enter /exit, then retry");
        if (final.Length > 20000) throw new Exception("Claude answer exceeds 20000 characters");
        return final.Trim();
    }

    static bool IsExitCommand(string? text) => text != null && Regex.IsMatch(text.Trim(), @"^<command-name>/exit</command-name>\s*<command-message>exit</command-message>\s*<command-args></command-args>$", RegexOptions.CultureInvariant);
    static bool IsExitOutput(string? text) => text != null && Regex.IsMatch(text.Trim(), @"^<local-command-stdout>[^<\r\n]{0,200}</local-command-stdout>$", RegexOptions.CultureInvariant);
}
internal sealed class Job : IDisposable
{
    private readonly IntPtr handle;
    public Job() {
        handle = CreateJobObject(IntPtr.Zero,null); if (handle == IntPtr.Zero) throw new Exception("Cannot create JobObject");
        var limits = new ExtendedLimits(); limits.Basic.LimitFlags = 0x2000;
        int size = Marshal.SizeOf<ExtendedLimits>(); var ptr = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(limits,ptr,false); if (!SetInformationJobObject(handle,9,ptr,(uint)size)) throw new Exception("Cannot configure JobObject"); } finally { Marshal.FreeHGlobal(ptr); }
    }
    public Process StartSuspended(ProcessStartInfo start,IntPtr input,IntPtr output,IntPtr error,bool hidden) {
        var startup = new Startup { Size = Marshal.SizeOf<Startup>(), Flags = hidden ? 0x100u : 0u, Input=input,Output=output,Error=error };
        var command = new System.Text.StringBuilder(Quote(start.FileName) + " " + string.Join(" ",start.ArgumentList.Select(Quote)));
        var block = string.Join("\0",start.Environment.OrderBy(x=>x.Key,StringComparer.OrdinalIgnoreCase).Select(x=>x.Key+"="+x.Value))+"\0\0";
        var env = Marshal.StringToHGlobalUni(block);
        try {
            uint flags = hidden ? 0x08000404u : 0x00000404u;
            if (!CreateProcess(start.FileName,command,IntPtr.Zero,IntPtr.Zero,true,flags,env,start.WorkingDirectory,ref startup,out var info)) throw new Exception("Cannot create suspended Claude: "+Marshal.GetLastWin32Error());
            try { var child = Process.GetProcessById((int)info.ProcessId); Assign(child); if (ResumeThread(info.Thread)==uint.MaxValue) { Terminate(); throw new Exception("Cannot resume Claude"); } return child; }
            finally { CloseHandle(info.Process); CloseHandle(info.Thread); }
        } finally { Marshal.FreeHGlobal(env); }
    }
    private static string Quote(string value) {
        var result = new System.Text.StringBuilder(); result.Append((char)34); int slashes=0;
        foreach (var c in value) {
            if (c == (char)92) { slashes++; continue; }
            result.Append((char)92, c == (char)34 ? slashes*2+1 : slashes); result.Append(c); slashes=0;
        }
        result.Append((char)92,slashes*2); result.Append((char)34); return result.ToString();
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int Size; public string? Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPtr,Input,Output,Error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,System.Text.StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    public void Assign(Process child) { if (!AssignProcessToJobObject(handle,child.Handle)) { child.Kill(true); child.WaitForExit(); throw new Exception("Cannot contain Claude process"); } }
    public void Terminate() {
        if (!TerminateJobObject(handle,1)) throw new Exception("JobObject termination failed");
        var ptr = Marshal.AllocHGlobal(48);
        try {
            for (int attempt=0;attempt<100;attempt++) {
                if (!QueryInformationJobObject(handle,1,ptr,48,IntPtr.Zero)) throw new Exception("Cannot verify JobObject termination");
                if (Marshal.ReadInt32(ptr,40)==0) return;
                Thread.Sleep(50);
            }
            throw new Exception("JobObject descendants have not exited");
        } finally { Marshal.FreeHGlobal(ptr); }
    }
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,uint size,IntPtr returned);
    public void Dispose() => CloseHandle(handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime,JobTime; public uint LimitFlags; public UIntPtr MinWorking,MaxWorking; public uint ActiveProcess; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string? name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
}
