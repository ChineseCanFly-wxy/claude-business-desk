using System.Security.Cryptography;
using System.Text;
using Microsoft.Toolkit.Uwp.Notifications;
using Windows.UI.Notifications;

namespace ClaudeBusinessDesk.Launcher;

internal sealed class ReviewReminders
{
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    internal string Mode { get; private set; } = "window";

    internal ReviewItem[] TakeNew(IReadOnlyCollection<ReviewItem> items, string mode)
    {
        mode = mode == "notification" ? mode : "window";
        if (Mode != mode) { seen.Clear(); Mode = mode; }
        seen.IntersectWith(items.Select(item => item.Key));
        return items.Where(item => seen.Add(item.Key)).ToArray();
    }

    internal void Retry(ReviewItem item) => seen.Remove(item.Key);
    internal void Reset() => seen.Clear();
}

internal sealed class ReviewNotifications
{
    private const string Group = "review";
    private readonly Dictionary<string, string> shown = new(StringComparer.Ordinal);
    internal string? Error { get; private set; }

    internal static Uri ReviewUri(ReviewItem item, int port) => new($"http://127.0.0.1:{port}/?review={Uri.EscapeDataString(item.Id)}&stage={Uri.EscapeDataString(item.Status)}&version={Uri.EscapeDataString(item.UpdatedAt)}");
    internal static string Tag(ReviewItem item) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(item.Key)))[..16];
    internal static ToastContent Content(ReviewItem item, int port)
    {
        var uri = ReviewUri(item, port);
        return new ToastContentBuilder()
            .AddText(item.Status == "pending_question_review" ? "沐雨橙风 · 新问题待审核" : "沐雨橙风 · 答案待审核")
            .AddText("点击打开审核页面，查看内容并选择同意或拒绝。")
            .SetProtocolActivation(uri)
            .AddButton(new ToastButton().SetContent("打开审核").SetProtocolActivation(uri))
            .GetToastContent();
    }

    internal bool Show(ReviewItem item, int port)
    {
        try
        {
            var notifier = ToastNotificationManagerCompat.CreateToastNotifier();
            if (notifier.Setting != NotificationSetting.Enabled)
                throw new InvalidOperationException("Windows 通知已关闭，请在系统通知设置中开启，或选择独立审核窗口。");
            string tag = Tag(item);
            notifier.Show(new ToastNotification(Content(item, port).GetXml()) { Tag = tag, Group = Group, ExpirationTime = DateTimeOffset.Now.AddDays(1) });
            shown[item.Key] = tag;
            Error = null;
            return true;
        }
        catch (Exception ex) { Fail(ex); return false; }
    }

    internal void Retain(HashSet<string> keys)
    {
        foreach (var key in shown.Keys.Where(key => !keys.Contains(key)).ToArray())
        {
            try { ToastNotificationManagerCompat.History.Remove(shown[key], Group); shown.Remove(key); }
            catch (Exception ex) { Fail(ex); }
        }
    }

    private void Fail(Exception ex)
    {
        string message = $"Windows 通知不可用：{ex.Message}";
        if (Error != message) Program.Report(message);
        Error = message;
    }

    // Pure checks: no registration, toast display, browser, or application window.
    internal static void Check()
    {
        static void Require(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
        var question = new ReviewItem("11111111-1111-1111-1111-111111111111", "pending_question_review", "2026-10-02T01:02:03.000Z");
        var answer = question with { Status = "pending_answer_review", UpdatedAt = "2026-10-02T01:02:04.000Z" };
        var reminders = new ReviewReminders();
        Require(reminders.TakeNew([question], "window").Length == 1, "Initial review missing");
        Require(reminders.TakeNew([question], "window").Length == 0, "Duplicate review");
        Require(reminders.TakeNew([question], "notification").Length == 1, "Mode switch missing");
        Require(reminders.TakeNew([question], "notification").Length == 0, "Duplicate toast");
        Require(reminders.TakeNew([answer], "notification").Length == 1, "Answer review missing");
        reminders.Retry(answer);
        Require(reminders.TakeNew([answer], "notification").Length == 1, "Failed toast cannot retry");
        Require(reminders.TakeNew([], "notification").Length == 0, "Resolved review reappeared");
        Require(reminders.TakeNew([question], "both").Length == 1 && reminders.Mode == "window", "Invalid mode must use default");
        var xml = System.Xml.Linq.XDocument.Parse(Content(question, 4310).GetContent());
        Require((string?)xml.Root?.Attribute("activationType") == "protocol", "Toast body must open review URL");
        var launch = new Uri((string)xml.Root!.Attribute("launch")!);
        Require(launch.Host == "127.0.0.1" && launch.Port == 4310 && launch.Query.Contains("stage=pending_question_review"), "Wrong review destination");
        Require(xml.Descendants("action").All(action => (string?)action.Attribute("activationType") == "protocol" && (string?)action.Attribute("arguments") == launch.AbsoluteUri), "Toast button must not approve");
        Require(Tag(question).Length == 16 && Tag(question) != Tag(answer), "Notification identity collision");
        Require(Content(answer, 4310).GetContent().Contains("答案待审核"), "Wrong answer notification");
    }
}
