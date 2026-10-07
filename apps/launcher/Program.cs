using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace ClaudeBusinessDesk.Launcher;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--check-notifications" }))
        {
            try { ReviewNotifications.Check(); Console.WriteLine("Notification checks passed; no UI or OS notifications opened."); }
            catch (Exception ex) { Console.Error.WriteLine(ex); Environment.ExitCode = 1; }
            return;
        }
        if (StartupRegistration.Handle(args)) return;
        if (args.Length != 0)
        {
            if (args.Length != 2 || args[0] != "--data-dir" || !Path.IsPathFullyQualified(args[1]) || args[1].StartsWith(@"\\") || args[1].Any(char.IsControl))
            { Console.Error.WriteLine("Invalid launcher arguments."); Environment.ExitCode = 1; return; }
            Environment.SetEnvironmentVariable("DESK_DATA_DIR", Path.GetFullPath(args[1]));
        }
        ApplicationConfiguration.Initialize();
        using var single = new Mutex(true, "Local\\ClaudeBusinessDeskLauncher", out bool first);
        if (!first) { Report("沐雨橙风已在托盘运行。"); return; }
        Application.Run(new TrayContext());
    }

    internal static string DataDirectory => Environment.GetEnvironmentVariable("DESK_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeBusinessDesk");

    internal static void Report(string message)
    {
        Console.Error.WriteLine(message);
        try
        {
            Directory.CreateDirectory(DataDirectory);
            File.AppendAllText(Path.Combine(DataDirectory, "launcher.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}", Encoding.UTF8);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Console.Error.WriteLine(ex.Message); }
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly NotifyIcon tray = new() { Icon = SystemIcons.Application, Text = "沐雨橙风", Visible = true };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 5000 };
    // Never follow redirects with the local launcher secret.
    private readonly HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };
    private readonly Control dispatcher = new();
    private readonly string root = AppContext.BaseDirectory;
    private readonly string data = Program.DataDirectory;
    private JobHandle? job;
    private Process? backend;
    private bool polling, stopping;
    private readonly ReviewReminders reminders = new();
    private readonly ReviewNotifications notifications = new();
    private readonly Queue<ReviewItem> reviews = new();
    private ReviewForm? reviewForm;
    private ReviewItem? activeReview;
    private bool closingReviews;
    private string? clientUrl;

    public TrayContext()
    {
        _ = dispatcher.Handle; // Marshal process-exit callbacks back to the UI thread.
        var menu = new ContextMenuStrip();
        menu.Items.Add("启动服务", null, (_, _) => Start());
        menu.Items.Add("停止服务", null, (_, _) => Stop());
        menu.Items.Add("打开管理端", null, (_, _) => OpenAdmin());
        menu.Items.Add("复制客户地址", null, (_, _) => {
            try
            {
                if (ReadConnection() != null && clientUrl != null) Clipboard.SetText(clientUrl);
                else Report("客户入口未启动", "请打开管理端修正客户监听地址或端口，保存后停止并重新启动服务。");
            }
            catch (Exception ex) { Report("复制客户地址失败", ex.Message); }
        });
        menu.Items.Add("退出（停止服务）", null, (_, _) => ExitThread());
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (_, _) => OpenAdmin();
        timer.Tick += async (_, _) => await Poll();
        timer.Start();
        Start();
    }

    private int? ReadConnection()
    {
        clientUrl = null;
        try
        {
            using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(data, "connection.json"), Encoding.UTF8));
            var obj = json.RootElement;
            // Only trust the connection record belonging to our current backend.
            if (backend == null || backend.HasExited || obj.GetProperty("pid").GetInt32() != backend.Id) return null;
            int port = obj.GetProperty("adminPort").GetInt32();
            if (port is < 1 or > 65535) return null;
            clientUrl = obj.TryGetProperty("clientUrl", out var url) && url.ValueKind == JsonValueKind.String && Uri.TryCreate(url.GetString(), UriKind.Absolute, out var parsed) && (parsed.Scheme == "http" || parsed.Scheme == "https") ? parsed.AbsoluteUri : null;
            return port;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException) { return null; }
    }

    private void OpenAdmin()
    {
        try
        {
            if (ReadConnection() is int port)
                Process.Start(new ProcessStartInfo($"http://127.0.0.1:{port}") { UseShellExecute = true });
            else Report("服务尚未就绪", "请先启动服务后重试。");
        }
        catch (Exception ex) { Report("打开管理端失败", ex.Message); }
    }

    private void Report(string status, string message)
    {
        tray.Text = $"沐雨橙风 · {status}";
        Program.Report($"{status}：{message}");
    }

    private void ResetReviews()
    {
        reminders.Reset(); notifications.Retain(new(StringComparer.Ordinal)); reviews.Clear(); activeReview = null;
        closingReviews = true;
        reviewForm?.Close(); reviewForm = null;
        closingReviews = false;
    }

    private void ShowNextReview()
    {
        if (closingReviews || reviewForm != null || reviews.Count == 0 || ReadConnection() is not int port) return;
        activeReview = reviews.Dequeue();
        var item = activeReview;
        var uri = ReviewNotifications.ReviewUri(item, port);
        var form = new ReviewForm(uri, Path.Combine(data, "launcher-webview"), item.Status);
        reviewForm = form;
        form.FormClosed += (_, _) =>
        {
            if (!ReferenceEquals(reviewForm, form)) return;
            reviewForm = null; activeReview = null;
            if (!closingReviews && !dispatcher.IsDisposed)
                dispatcher.BeginInvoke((Action)ShowNextReview);
        };
        form.Show(); // Non-modal: polling and the tray remain responsive.
    }

    private void Start()
    {
        if (backend is { HasExited: false }) return;
        string node = Path.Combine(root, "runtime", "node.exe");
        string entry = Path.Combine(root, "dist", "server", "main.js");
        if (!File.Exists(node) || !File.Exists(entry))
        {
            Report("服务启动失败", "发行目录缺少 runtime/node.exe 或 dist/server/main.js。请先完成发行打包；源码目录可用 scripts/启动.cmd。");
            return;
        }
        Stop();
        try
        {
            Directory.CreateDirectory(data);
            // Start suspended so no descendants can escape before Job assignment.
            job = Native.CreateKillOnCloseJob();
            var si = new Native.StartupInfo { cb = Marshal.SizeOf<Native.StartupInfo>() };
            Environment.SetEnvironmentVariable("DESK_DATA_DIR", data);
            var command = new StringBuilder($"\"{node}\" \"{entry}\"");
            if (!Native.CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, 0x00000004 | 0x08000000, IntPtr.Zero, root, ref si, out var pi))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                if (!Native.AssignProcessToJobObject(job, pi.hProcess))
                {
                    Native.TerminateProcess(pi.hProcess, 1);
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                backend = Process.GetProcessById((int)pi.dwProcessId);
                backend.EnableRaisingEvents = true;
                backend.Exited += BackendExited;
                if (Native.ResumeThread(pi.hThread) == uint.MaxValue)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                ResetReviews();
                tray.Text = "沐雨橙风 · 服务启动中";
            }
            finally { Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess); }
        }
        catch (Exception ex) { Stop(); Report("服务启动失败", ex.Message); }
    }

    private void BackendExited(object? sender, EventArgs e)
    {
        try
        {
            dispatcher.BeginInvoke((Action)(() =>
            {
                if (stopping || !ReferenceEquals(sender, backend)) return;
                // Closing the job also kills surviving grandchildren of this backend.
                job?.Dispose(); job = null;
                ResetReviews();
                Report("服务已退出", "后端进程已退出，其子进程已清理。请在托盘重新启动。");
            }));
        }
        catch (InvalidOperationException) { /* UI is closing; Stop disposes the Job. */ }
    }

    private void Stop()
    {
        stopping = true;
        if (backend != null) backend.Exited -= BackendExited;
        job?.Dispose(); job = null;
        backend?.Dispose(); backend = null;
        clientUrl = null;
        ResetReviews();
        tray.Text = "沐雨橙风 · 服务已停止";
        stopping = false;
    }

    private async Task Poll()
    {
        if (polling || backend is not { HasExited: false }) return;
        polling = true;
        var polledBackend = backend;
        try
        {
            string tokenFile = Path.Combine(data, "launcher.token");
            if (!File.Exists(tokenFile)) return;
            string token = (await File.ReadAllTextAsync(tokenFile, Encoding.UTF8)).Trim();
            if (token.Length == 0) return;
            if (ReadConnection() is not int adminPort) return;
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{adminPort}/api/launcher/events");
            request.Headers.Add("x-launcher-token", token);
            using var response = await http.SendAsync(request);
            if (!response.IsSuccessStatusCode) return;
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (!ReferenceEquals(polledBackend, backend) || polledBackend.HasExited || dispatcher.IsDisposed) return;
            var obj = json.RootElement;
            int questions = obj.GetProperty("pendingQuestions").GetInt32();
            int answers = obj.GetProperty("pendingAnswers").GetInt32();
            if (questions < 0 || answers < 0) return;
            clientUrl = obj.TryGetProperty("clientUrl", out var url) && url.ValueKind == JsonValueKind.String && Uri.TryCreate(url.GetString(), UriKind.Absolute, out var parsed) && (parsed.Scheme == "http" || parsed.Scheme == "https") ? parsed.AbsoluteUri : null;
            if (!obj.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return;
            var current = new List<ReviewItem>();
            foreach (var element in items.EnumerateArray())
            {
                string? id = element.GetProperty("id").GetString();
                string? status = element.GetProperty("status").GetString();
                string? version = element.GetProperty("updatedAt").GetString();
                if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(version) ||
                    status is not ("pending_question_review" or "pending_answer_review")) continue;
                current.Add(new ReviewItem(id, status, version));
            }
            string mode = obj.TryGetProperty("adminNotificationMode", out var modeValue) && modeValue.ValueKind == JsonValueKind.String && modeValue.GetString() == "notification" ? "notification" : "window";
            if (mode != reminders.Mode) reviews.Clear(); // Preserve an open review and its unsaved edits.
            var keys = current.Select(item => item.Key).ToHashSet(StringComparer.Ordinal);
            notifications.Retain(mode == "notification" ? keys : new(StringComparer.Ordinal));
            // Discard work already handled elsewhere. Never announce a count decrease.
            var remaining = reviews.Where(item => keys.Contains(item.Key)).ToArray();
            reviews.Clear();
            foreach (var item in remaining) reviews.Enqueue(item);
            if (activeReview != null && !keys.Contains(activeReview.Key))
            {
                closingReviews = true;
                reviewForm?.Close();
                closingReviews = false;
            }
            foreach (var item in reminders.TakeNew(current, mode))
            {
                if (activeReview?.Key == item.Key) continue;
                if (mode == "window") reviews.Enqueue(item);
                else if (!notifications.Show(item, adminPort)) reminders.Retry(item);
            }
            tray.Text = mode == "notification" && notifications.Error != null ? "沐雨橙风 · Windows 通知不可用 · 请查看管理台" : $"沐雨橙风 · 服务运行中 · 待审 {questions + answers}";
            ShowNextReview();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException) { /* Local service may be starting or stopping; retry next tick. */ }
        finally { polling = false; }
    }

    protected override void ExitThreadCore()
    {
        timer.Stop(); Stop(); tray.Visible = false;
        timer.Dispose(); tray.Dispose(); http.Dispose(); dispatcher.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class JobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public JobHandle() : base(true) { }
    protected override bool ReleaseHandle() => Native.CloseHandle(handle);
}

internal static class Native
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo { public int cb; public string? lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] internal struct ProcessInfo { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern JobHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(JobHandle job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(JobHandle job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    internal static JobHandle CreateKillOnCloseJob()
    {
        var handle = CreateJobObject(IntPtr.Zero, null);
        if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var info = new ExtendedLimits { BasicLimitInformation = new BasicLimits { LimitFlags = 0x2000 } };
        if (!SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf<ExtendedLimits>())) { handle.Dispose(); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
        return handle;
    }
}
