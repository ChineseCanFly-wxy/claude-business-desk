using System.Text;
using System.Text.Json;
namespace DeskDialogHost;
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 2 || (args[0] != "file" && args[0] != "directory")) return 2;
        ApplicationConfiguration.Initialize();
        string? path = null;
        string initial = args[1];
        try
        {
            using var owner = new Form { Text = "沐雨橙风 · 浏览选择", TopMost = true, ShowInTaskbar = false, Opacity = 0, Width = 1, Height = 1, StartPosition = FormStartPosition.CenterScreen };
            owner.Show(); owner.Activate();
            if (args[0] == "file")
            {
                using var dialog = new OpenFileDialog { Title = "选择 Claude Code 执行程序", Filter = "Windows 执行程序 (*.exe)|*.exe", CheckFileExists = true, Multiselect = false };
                if (File.Exists(initial)) { dialog.InitialDirectory = Path.GetDirectoryName(initial); dialog.FileName = Path.GetFileName(initial); }
                else if (Directory.Exists(initial)) dialog.InitialDirectory = initial;
                if (dialog.ShowDialog(owner) == DialogResult.OK) path = Path.GetFullPath(dialog.FileName);
            }
            else
            {
                using var dialog = new FolderBrowserDialog { Description = "选择本机业务项目目录", UseDescriptionForTitle = true, ShowNewFolderButton = false };
                if (Directory.Exists(initial)) dialog.SelectedPath = initial;
                if (dialog.ShowDialog(owner) == DialogResult.OK) path = Path.GetFullPath(dialog.SelectedPath);
            }
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(JsonSerializer.Serialize(new { path }));
            return 0;
        }
        catch { return 1; }
    }
}
