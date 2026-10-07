using System.Text;
using System.Text.Json;
namespace DeskDialogHost;
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--check-dialog" }))
        {
            try { ApplicationConfiguration.Initialize(); PathPicker.Check(); Console.WriteLine("Native picker checks passed: folder and EXE selection, cancel and file filtering."); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        if (args.Length != 2 || (args[0] != "file" && args[0] != "directory")) return 2;
        ApplicationConfiguration.Initialize();
        try
        {
            using var picker = new PathPicker(args[0] == "file", args[1]);
            var path = picker.ShowDialog() == DialogResult.OK ? picker.SelectedPath : null;
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(JsonSerializer.Serialize(new { path }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}

// ponytail: filesystem-only browsing avoids blocked shell initialization; add shell integration only when reliable.
internal sealed class PathPicker : Form
{
    private readonly bool file;
    private readonly Label location = new() { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly Label note = new() { Dock = DockStyle.Fill, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft };
    private readonly ComboBox drives = new() { Dock = DockStyle.Fill, DropDownStyle = ComboBoxStyle.DropDownList };
    private readonly ListView entries = new() { Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, MultiSelect = false, HideSelection = false };
    private readonly Button choose = new() { AutoSize = true };
    private string current = "";
    public string? SelectedPath { get; private set; }

    public PathPicker(bool file, string initial)
    {
        this.file = file;
        Text = file ? "选择 Claude Code 执行程序" : "选择本机业务项目目录";
        Size = new Size(720, 520); MinimumSize = new Size(560, 400);
        StartPosition = FormStartPosition.CenterScreen; TopMost = true;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 2, RowCount = 4 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        var up = new Button { Text = "上一级", AutoSize = true, Dock = DockStyle.Fill };
        up.Click += (_, _) => { var parent = current.Length == 0 ? null : Directory.GetParent(current); if (parent != null) Open(parent.FullName); };
        layout.Controls.Add(location, 0, 0); layout.Controls.Add(up, 1, 0);
        foreach (var drive in DriveInfo.GetDrives().Where(d => d.DriveType is DriveType.Fixed or DriveType.Removable)) drives.Items.Add(drive.Name);
        drives.SelectedIndexChanged += (_, _) => { if (drives.SelectedItem is string path && !current.StartsWith(path, StringComparison.OrdinalIgnoreCase)) Open(path); };
        layout.Controls.Add(drives, 0, 1); layout.SetColumnSpan(drives, 2);
        entries.Columns.Add("名称", 480); entries.Columns.Add("类型", 120);
        entries.SelectedIndexChanged += (_, _) => SelectionChanged();
        entries.DoubleClick += (_, _) => { var path = Selected(); if (path == null) return; if (Directory.Exists(path)) Open(path); else Confirm(); };
        layout.Controls.Add(entries, 0, 2); layout.SetColumnSpan(entries, 2);
        choose.Text = file ? "选择 EXE" : "选择文件夹"; choose.Click += (_, _) => Confirm();
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(0, 8, 0, 0) };
        actions.Controls.Add(choose); actions.Controls.Add(cancel);
        layout.Controls.Add(note, 0, 3); layout.Controls.Add(actions, 1, 3);
        Controls.Add(layout); AcceptButton = choose; CancelButton = cancel;
        var directory = File.Exists(initial) ? Path.GetDirectoryName(initial)! : Directory.Exists(initial) ? initial : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Open(directory);
        foreach (ListViewItem item in entries.Items) if (string.Equals(item.Tag as string, initial, StringComparison.OrdinalIgnoreCase)) { item.Selected = true; item.EnsureVisible(); break; }
    }

    private string? Selected() => entries.SelectedItems.Count == 1 ? entries.SelectedItems[0].Tag as string : null;
    private void SelectionChanged()
    {
        var selected = Selected();
        choose.Enabled = file ? selected != null && File.Exists(selected) : Directory.Exists(selected ?? current);
        note.Text = file ? selected == null ? "请选择 Claude Code 的 .exe 文件" : selected : selected ?? current;
    }

    private void Open(string path)
    {
        try
        {
            path = Path.GetFullPath(path);
            if (path.StartsWith(@"\\") || path.Any(char.IsControl)) throw new IOException("请选择本机目录");
            var folders = Directory.GetDirectories(path).Order(StringComparer.OrdinalIgnoreCase);
            var programs = file ? Directory.GetFiles(path).Where(p => Path.GetExtension(p).Equals(".exe", StringComparison.OrdinalIgnoreCase)).Order(StringComparer.OrdinalIgnoreCase) : Enumerable.Empty<string>();
            var items = folders.Select(p => Item(p, "文件夹")).Concat(programs.Select(p => Item(p, "执行程序"))).ToArray();
            entries.BeginUpdate(); entries.Items.Clear(); entries.Items.AddRange(items); entries.EndUpdate();
            current = path; location.Text = path; location.AccessibleName = "当前位置：" + path;
            var root = Path.GetPathRoot(path); if (drives.Items.Contains(root)) drives.SelectedItem = root;
            SelectionChanged();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        { note.Text = "无法打开该目录：" + error.Message; }
    }

    internal static void Check()
    {
        var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()));
        var directory = Path.GetFullPath(Path.Combine(temporaryRoot, "desk-picker-check-" + Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(directory);
        try
        {
            var folder = Directory.CreateDirectory(Path.Combine(directory, "业务 项目")).FullName;
            var executable = Path.Combine(directory, "Claude 测试.EXE"); File.WriteAllText(executable, "fixture; never executed");
            File.WriteAllText(Path.Combine(directory, "not-a-program.txt"), "fixture");
            foreach (bool fileMode in new[] { false, true })
            {
                using var picker = new PathPicker(fileMode, fileMode ? executable : directory);
                picker.Shown += (_, _) => {
                    if (picker.entries.Items.Cast<ListViewItem>().Any(item => Path.GetExtension((string)item.Tag!).Equals(".txt", StringComparison.OrdinalIgnoreCase))) throw new Exception("Unrelated files must not be selectable.");
                    picker.Confirm();
                };
                if (picker.ShowDialog() != DialogResult.OK || picker.SelectedPath != (fileMode ? executable : directory)) throw new Exception("Initial local path must be selectable.");
                using var cancelled = new PathPicker(fileMode, directory);
                cancelled.Shown += (_, _) => cancelled.DialogResult = DialogResult.Cancel;
                if (cancelled.ShowDialog() != DialogResult.Cancel || cancelled.SelectedPath != null) throw new Exception("Cancel must return no path.");
            }
            using var nested = new PathPicker(false, directory);
            nested.Shown += (_, _) => { nested.Open(folder); nested.Confirm(); };
            if (nested.ShowDialog() != DialogResult.OK || nested.SelectedPath != folder) throw new Exception("Folder navigation must preserve Unicode and spaces.");
        }
        finally
        {
            if (Path.GetDirectoryName(directory) != temporaryRoot) throw new Exception("Refusing to delete outside the picker check directory.");
            Directory.Delete(directory, recursive: true);
        }
    }

    private static ListViewItem Item(string path, string type) => new(new[] { Path.GetFileName(path), type }) { Tag = path };
    private void Confirm()
    {
        var path = Selected() ?? (file ? null : current);
        if (path == null || (file ? !File.Exists(path) || !Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase) : !Directory.Exists(path))) return;
        SelectedPath = Path.GetFullPath(path); DialogResult = DialogResult.OK;
    }
}
