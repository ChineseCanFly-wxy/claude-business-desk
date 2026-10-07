using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace ClaudeBusinessDesk.Launcher;

internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Entry = "ClaudeBusinessDesk";

    internal static bool Handle(string[] args)
    {
        if (args.Length == 0 || !new[] { "--startup-status", "--startup", "--check-startup" }.Contains(args[0])) return false;
        try
        {
            if (args.SequenceEqual(new[] { "--check-startup" }))
            { Check(); Console.WriteLine("Startup checks passed; the real Windows startup entry was not changed."); return true; }
            if (args.SequenceEqual(new[] { "--startup-status" }))
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKey);
                WriteStatus(key);
            }
            else if (args.Length == 2 && args[0] == "--startup" && args[1] is "enable" or "disable")
            {
                using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
                Set(key, args[1] == "enable");
                WriteStatus(key);
            }
            else throw new ArgumentException("无效的开机自启参数");
        }
        catch (Exception ex)
        { Console.WriteLine(JsonSerializer.Serialize(new { message = ex.Message })); Environment.ExitCode = 1; }
        return true;
    }

    private static string Command()
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("无法确定启动程序的位置");
        var data = Path.GetFullPath(Program.DataDirectory);
        if (data.StartsWith(@"\\") || data.Any(char.IsControl)) throw new ArgumentException("数据目录必须是本机完整路径");
        return Quote(executable) + " --data-dir " + Quote(data);
    }

    private static (bool Enabled, bool CurrentLocation) Status(RegistryKey? key)
    {
        var value = key?.GetValue(Entry) as string;
        return (!string.IsNullOrWhiteSpace(value), string.Equals(value, Command(), StringComparison.OrdinalIgnoreCase));
    }

    private static void WriteStatus(RegistryKey? key)
    {
        var status = Status(key);
        Console.WriteLine(JsonSerializer.Serialize(new { available = true, enabled = status.Enabled, currentLocation = status.CurrentLocation }));
    }

    private static void Set(RegistryKey key, bool enabled)
    {
        if (!enabled) { key.DeleteValue(Entry, throwOnMissingValue: false); return; }
        var command = Command();
        if (command.Length > 260) throw new ArgumentException("程序或数据目录路径过长，无法设置开机自启，请将程序放在更短的路径下");
        key.SetValue(Entry, command, RegistryValueKind.String);
    }

    // Windows command-line quoting also preserves a trailing directory separator.
    private static string Quote(string value)
    {
        var result = new StringBuilder(); result.Append('"'); int slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }

    private static void Check()
    {
        var path = @"Software\ClaudeBusinessDesk\StartupCheck\" + Guid.NewGuid().ToString("N");
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(path, writable: true);
            key.SetValue("AnotherApplication", "untouched");
            if (Status(key).Enabled) throw new Exception("A fresh installation must default to disabled.");
            Set(key, true);
            if (Status(key) != (true, true)) throw new Exception("The current launcher must be registered.");
            key.SetValue(Entry, "previous location");
            if (Status(key) != (true, false)) throw new Exception("A moved installation must be detected.");
            Set(key, true); Set(key, false); Set(key, false);
            if (Status(key).Enabled || key.GetValue("AnotherApplication") as string != "untouched") throw new Exception("Disabling must only remove this app's entry.");
            if (Quote(@"C:\") != "\"C:\\\\\"") throw new Exception("Root directory quoting failed.");
        }
        finally { Registry.CurrentUser.DeleteSubKeyTree(path, throwOnMissingSubKey: false); }
    }
}
