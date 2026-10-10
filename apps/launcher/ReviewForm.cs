using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClaudeBusinessDesk.Launcher;

internal sealed record ReviewItem(string Id, string Status, string UpdatedAt)
{
    public string Key => $"{Id}:{Status}:{UpdatedAt}";
}

internal sealed record ReviewLogin(string SessionToken, long Expires);

internal sealed class ReviewForm : Form
{
    private readonly Uri reviewUri;
    private readonly string userDataFolder;
    private readonly Func<Task<ReviewLogin?>> readLogin;
    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };

    public ReviewForm(Uri reviewUri, string userDataFolder, string status, Func<Task<ReviewLogin?>> readLogin)
    {
        this.reviewUri = reviewUri;
        this.userDataFolder = userDataFolder;
        this.readLogin = readLogin;
        Text = status == "pending_question_review" ? "沐雨橙风 · 新问题审核" : "沐雨橙风 · 答案审核";
        TopMost = true;
        MinimumSize = new Size(720, 560);
        Size = new Size(1000, 780);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(webView);
        Shown += async (_, _) => await InitializeAsync();
    }

    private bool SameOrigin(string? address) => Uri.TryCreate(address, UriKind.Absolute, out var uri)
        && uri.Scheme == reviewUri.Scheme
        && string.Equals(uri.Host, reviewUri.Host, StringComparison.OrdinalIgnoreCase)
        && uri.Port == reviewUri.Port && string.IsNullOrEmpty(uri.UserInfo);

    private async Task InitializeAsync()
    {
        try
        {
            // The native host copies a cookie linked to the existing admin login.
            // The launcher secret never enters WebView2 or a navigation URL.
            var environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder);
            if (IsDisposed) return;
            await webView.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            var core = webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += (_, e) => { if (!SameOrigin(e.Uri)) e.Cancel = true; };
            core.FrameNavigationStarting += (_, e) => { if (!SameOrigin(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => e.Cancel = true;
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.WebMessageReceived += (_, e) =>
            {
                if (!SameOrigin(e.Source)) return;
                try
                {
                    using var message = JsonDocument.Parse(e.WebMessageAsJson);
                    if (message.RootElement.TryGetProperty("type", out var type)
                        && type.ValueKind == JsonValueKind.String
                        && type.GetString() is "review-close" or "review-later") Close();
                }
                catch (JsonException) { /* Ignore unrelated page messages. */ }
            };
            var login = await readLogin();
            if (IsDisposed) return;
            if (login != null)
            {
                var cookie = core.CookieManager.CreateCookie("desk_admin", login.SessionToken, reviewUri.Host, "/");
                cookie.IsHttpOnly = true;
                cookie.IsSecure = reviewUri.Scheme == "https";
                cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
                cookie.Expires = DateTimeOffset.FromUnixTimeMilliseconds(login.Expires).UtcDateTime;
                core.CookieManager.AddOrUpdateCookie(cookie);
            }
            core.Navigate(reviewUri.AbsoluteUri);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (IsDisposed) return;
            ShowError("未安装 Microsoft Edge WebView2 Runtime，无法显示审核页面。请安装后重试，或点击下方按钮在浏览器中审核。");
        }
        catch (Exception ex)
        {
            if (IsDisposed) return;
            ShowError($"审核窗口初始化失败：{ex.Message}");
        }
    }

    private void ShowError(string message)
    {
        Program.Report(message);
        webView.Visible = false;
        var error = new Label { Text = message, Dock = DockStyle.Fill, Padding = new Padding(24), AutoSize = false };
        var open = new Button { Text = "在浏览器中审核", Dock = DockStyle.Bottom, Height = 48 };
        open.Click += (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo(reviewUri.AbsoluteUri) { UseShellExecute = true }); }
            catch (Exception ex) { error.Text = $"浏览器打开失败：{ex.Message}"; Program.Report(error.Text); }
        };
        Controls.Add(error);
        Controls.Add(open);
    }
}
