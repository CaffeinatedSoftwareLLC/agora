// Native launcher for fake-claude.mjs on Windows. agora-host refuses .cmd/.bat/.ps1 shims and
// runs the executable with shell: false, so a Node script needs a real .exe in front of it.
// lib/fake-host.ts fills in the node and script paths and compiles this with the
// .NET Framework's csc.exe into a run-scoped temp folder. It forwards argv, stdin, stdout and
// stderr unchanged and returns the script's exit code; taskkill /T stops both processes.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

class FakeClaudeLauncher {
    const string Node = @"__NODE__";
    const string Script = @"__SCRIPT__";

    // CommandLineToArgvW quoting
    static string Quote(string a) {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        for (int i = 0; ; i++) {
            int slashes = 0;
            while (i < a.Length && a[i] == '\\') { i++; slashes++; }
            if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
            if (a[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
            else { sb.Append('\\', slashes); sb.Append(a[i]); }
        }
        sb.Append('"');
        return sb.ToString();
    }

    static void Pump(Stream from, Stream to, bool closeTo) {
        var buf = new byte[65536];
        try {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); }
        } catch (IOException) { }
        if (closeTo) { try { to.Close(); } catch (IOException) { } }
    }

    static int Main(string[] args) {
        var cmd = new StringBuilder(Quote(Script));
        foreach (var a in args) { cmd.Append(' '); cmd.Append(Quote(a)); }
        var psi = new ProcessStartInfo(Node, cmd.ToString());
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
        var p = Process.Start(psi);
        var stdout = Console.OpenStandardOutput(); var stderr = Console.OpenStandardError(); var stdin = Console.OpenStandardInput();
        var tOut = new Thread(() => Pump(p.StandardOutput.BaseStream, stdout, false));
        var tErr = new Thread(() => Pump(p.StandardError.BaseStream, stderr, false));
        var tIn = new Thread(() => Pump(stdin, p.StandardInput.BaseStream, true)) { IsBackground = true };
        tOut.Start(); tErr.Start(); tIn.Start();
        p.WaitForExit(); tOut.Join(); tErr.Join();
        return p.ExitCode;
    }
}
