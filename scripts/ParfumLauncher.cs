using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class ParfumLauncher
{
    private const string NodeVersion = "v26.13.1";
    private const string Address = "http://127.0.0.1:4173";
    private static readonly object LogLock = new object();
    private static string logFile;

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string programName = Path.GetFileNameWithoutExtension(Application.ExecutablePath);
        string appRoot = Path.GetDirectoryName(Application.ExecutablePath);
        string dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ParfumProjets");
        string logsRoot = Path.Combine(dataRoot, "logs");
        string controlRoot = Path.Combine(dataRoot, "control");
        logFile = Path.Combine(logsRoot, "launcher.log");

        try
        {
            Directory.CreateDirectory(logsRoot);
            Directory.CreateDirectory(controlRoot);
            if (String.Equals(programName, "Fermer Parfum", StringComparison.OrdinalIgnoreCase))
                StopApplication(dataRoot);
            else
                StartApplication(appRoot, dataRoot, logsRoot, controlRoot);
        }
        catch (Exception ex)
        {
            WriteLog("Erreur : " + ex);
            ShowMessage("Impossible de démarrer Parfum : " + ex.Message + Environment.NewLine + Environment.NewLine + "Journal : " + logFile,
                "Parfum - démarrage impossible", MessageBoxIcon.Error);
        }
    }

    private static void StartApplication(string appRoot, string dataRoot, string logsRoot, string controlRoot)
    {
        if (!Environment.Is64BitOperatingSystem)
            throw new InvalidOperationException("Cette version nécessite Windows 64 bits.");

        if (IsApplicationRunning())
        {
            OpenBrowser();
            return;
        }

        string nodeHome = Path.Combine(dataRoot, "runtime", "node-" + NodeVersion + "-win-x64");
        string nodeExe = Path.Combine(nodeHome, "node.exe");
        if (!File.Exists(nodeExe))
        {
            WriteLog("Téléchargement du runtime Node.js officiel pour le premier lancement.");
            DownloadNode(nodeHome);
        }

        string npmCli = Path.Combine(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");
        if (!File.Exists(npmCli))
            throw new FileNotFoundException("Le runtime Node.js téléchargé ne contient pas npm.", npmCli);

        string packageFile = Path.Combine(appRoot, "package.json");
        string lockFile = Path.Combine(appRoot, "package-lock.json");
        if (!File.Exists(packageFile) || !File.Exists(lockFile))
            throw new FileNotFoundException("Le dossier de l’application est incomplet. Décompressez le dossier parfum-projets avant de lancer Parfum.");

        string fingerprint = PackageFingerprint(packageFile, lockFile);
        string modulesRoot = Path.Combine(appRoot, "node_modules");
        string marker = Path.Combine(modulesRoot, ".parfum-install-ok");
        string binaryPackage = Path.Combine(modulesRoot, "@embedded-postgres", "windows-x64");
        bool installCurrent = false;
        try { installCurrent = File.ReadAllText(marker).Trim() == fingerprint; } catch { }
        if (!installCurrent || !Directory.Exists(Path.Combine(modulesRoot, "pg")) ||
            !Directory.Exists(Path.Combine(modulesRoot, "embedded-postgres")) || !Directory.Exists(binaryPackage))
        {
            WriteLog("Installation des composants de l’application.");
            RunNpm(nodeExe, npmCli, appRoot, logsRoot, new string[] { "install", "--omit=dev", "--include=optional", "--no-audit", "--no-fund" });
            RunNpm(nodeExe, npmCli, appRoot, logsRoot, new string[] { "install", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "@embedded-postgres/windows-x64@17.12.0-beta.19" });
            RunNpm(nodeExe, npmCli, appRoot, logsRoot, new string[] { "rebuild", "--no-audit", "--no-fund", "@embedded-postgres/windows-x64" });
            Directory.CreateDirectory(modulesRoot);
            File.WriteAllText(marker, fingerprint, Encoding.ASCII);
        }

        string dataDirectory = Path.Combine(dataRoot, "data");
        Directory.CreateDirectory(dataDirectory);
        byte[] random = new byte[32];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(random);
        string token = Convert.ToBase64String(random);
        File.WriteAllText(Path.Combine(controlRoot, "shutdown-token.txt"), token, Encoding.ASCII);

        string serverScript = Path.Combine(appRoot, "server", "index.js");
        if (!File.Exists(serverScript)) throw new FileNotFoundException("Le serveur de l’application est introuvable.", serverScript);
        string serverLog = Path.Combine(logsRoot, "server.log");
        Process server = new Process();
        server.StartInfo = CreateNodeStartInfo(nodeExe, serverScript, appRoot, serverLog);
        server.StartInfo.EnvironmentVariables["PARFUM_DATA_DIR"] = dataDirectory;
        server.StartInfo.EnvironmentVariables["PARFUM_SHUTDOWN_TOKEN"] = token;
        server.StartInfo.EnvironmentVariables["PARFUM_OPEN_BROWSER"] = "0";
        server.StartInfo.EnvironmentVariables["NODE_ENV"] = "production";
        server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) AppendLine(serverLog, e.Data); };
        server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) AppendLine(serverLog, e.Data); };

        WriteLog("Démarrage du serveur Parfum en arrière-plan.");
        if (!server.Start()) throw new InvalidOperationException("Windows n’a pas pu démarrer le serveur.");
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();

        bool ready = false;
        for (int i = 0; i < 180; i++)
        {
            if (IsApplicationRunning()) { ready = true; break; }
            if (server.HasExited) break;
            Thread.Sleep(500);
        }
        if (!ready)
        {
            string reason = server.HasExited ? "Le serveur s’est arrêté pendant le démarrage." : "Le serveur met trop de temps à démarrer.";
            throw new InvalidOperationException(reason + " Consultez le journal : " + serverLog);
        }

        OpenBrowser();
        WriteLog("Parfum est prêt. Le serveur reste actif en arrière-plan.");
        server.WaitForExit();
        try { File.Delete(Path.Combine(controlRoot, "shutdown-token.txt")); } catch { }
        WriteLog("Le serveur Parfum est arrêté.");
    }

    private static void StopApplication(string dataRoot)
    {
        if (!IsApplicationRunning())
        {
            ShowMessage("Parfum est déjà fermé. Vos données restent enregistrées sur cet ordinateur.", "Parfum", MessageBoxIcon.Information);
            return;
        }

        string tokenPath = Path.Combine(dataRoot, "control", "shutdown-token.txt");
        if (!File.Exists(tokenPath))
            throw new InvalidOperationException("Le jeton de fermeture est introuvable. Relancez Parfum puis réessayez.");
        string token = File.ReadAllText(tokenPath, Encoding.ASCII).Trim();
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Address + "/api/shutdown");
        request.Method = "POST";
        request.Timeout = 5000;
        request.Headers["X-Parfum-Shutdown"] = token;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { }

        for (int i = 0; i < 40 && IsApplicationRunning(); i++) Thread.Sleep(250);
        ShowMessage("Parfum est fermé. Vos données locales sont conservées.", "Parfum", MessageBoxIcon.Information);
    }

    private static bool IsApplicationRunning()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Address + "/api/health");
            request.Timeout = 1200;
            request.ReadWriteTimeout = 1200;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return (int)response.StatusCode == 200 && reader.ReadToEnd().Contains("parfum-projets");
        }
        catch { return false; }
    }

    private static void DownloadNode(string nodeHome)
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        string runtimeRoot = Path.GetDirectoryName(nodeHome);
        Directory.CreateDirectory(runtimeRoot);
        string archiveName = "node-" + NodeVersion + "-win-x64.zip";
        string archivePath = Path.Combine(runtimeRoot, archiveName);
        string checksumPath = Path.Combine(runtimeRoot, "SHASUMS256.txt");
        string extractRoot = Path.Combine(runtimeRoot, "node-extract");
        using (TimedWebClient client = new TimedWebClient())
        {
            client.DownloadFile("https://nodejs.org/dist/" + NodeVersion + "/" + archiveName, archivePath);
            string checksums = client.DownloadString("https://nodejs.org/dist/" + NodeVersion + "/SHASUMS256.txt");
            string expected = FindChecksum(checksums, archiveName);
            string actual;
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(archivePath))
                actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("La vérification du téléchargement de Node.js a échoué. Aucun fichier n’a été installé.");
        }

        if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, true);
        Directory.CreateDirectory(extractRoot);
        try
        {
            string destinationRoot = Path.GetFullPath(extractRoot) + Path.DirectorySeparatorChar;
            using (FileStream file = File.OpenRead(archivePath))
            using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string entryPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    string destination = Path.GetFullPath(Path.Combine(extractRoot, entryPath));
                    if (!destination.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("L’archive Node.js contient un chemin inattendu.");
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal))
                        Directory.CreateDirectory(destination);
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        entry.ExtractToFile(destination, true);
                    }
                }
            }
            string unpacked = Path.Combine(extractRoot, "node-" + NodeVersion + "-win-x64");
            if (!File.Exists(Path.Combine(unpacked, "node.exe")))
                throw new InvalidDataException("L’archive Node.js ne contient pas le runtime attendu.");
            if (Directory.Exists(nodeHome)) Directory.Delete(nodeHome, true);
            Directory.Move(unpacked, nodeHome);
        }
        finally
        {
            if (Directory.Exists(extractRoot)) Directory.Delete(extractRoot, true);
            try { File.Delete(archivePath); } catch { }
            try { File.Delete(checksumPath); } catch { }
        }
        WriteLog("Runtime Node.js installé et vérifié.");
    }

    private static string FindChecksum(string checksums, string fileName)
    {
        using (StringReader reader = new StringReader(checksums))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                string trimmed = line.Trim();
                if (!trimmed.EndsWith(fileName, StringComparison.Ordinal)) continue;
                string[] pieces = trimmed.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (pieces.Length >= 2 && pieces[pieces.Length - 1] == fileName) return pieces[0];
            }
        }
        throw new InvalidDataException("L’empreinte de Node.js est absente du fichier officiel de sommes de contrôle.");
    }

    private static string PackageFingerprint(string packageFile, string lockFile)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] combined = Encoding.UTF8.GetBytes(File.ReadAllText(packageFile) + "\n" + File.ReadAllText(lockFile));
            return BitConverter.ToString(sha.ComputeHash(combined)).Replace("-", "").ToLowerInvariant();
        }
    }

    private static void RunNpm(string nodeExe, string npmCli, string appRoot, string logsRoot, string[] npmArguments)
    {
        string installLog = Path.Combine(logsRoot, "installation.log");
        Process process = new Process();
        process.StartInfo = CreateNodeStartInfo(nodeExe, npmCli, appRoot, installLog, npmArguments);
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) AppendLine(installLog, e.Data); };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) AppendLine(installLog, e.Data); };
        if (!process.Start()) throw new InvalidOperationException("Windows n’a pas pu lancer l’installation des composants.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        process.WaitForExit();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException("L’installation automatique a échoué (code " + process.ExitCode + "). Vérifiez votre connexion Internet et consultez : " + installLog);
    }

    private static ProcessStartInfo CreateNodeStartInfo(string nodeExe, string script, string workingDirectory, string logPath)
    {
        return CreateNodeStartInfo(nodeExe, script, workingDirectory, logPath, new string[0]);
    }

    private static ProcessStartInfo CreateNodeStartInfo(string nodeExe, string script, string workingDirectory, string logPath, string[] arguments)
    {
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = nodeExe;
        info.WorkingDirectory = workingDirectory;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(QuoteArgument(script));
        foreach (string argument in arguments) commandLine.Append(" ").Append(QuoteArgument(argument));
        info.Arguments = commandLine.ToString();
        info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(nodeExe) + ";" + Environment.GetEnvironmentVariable("PATH");
        info.EnvironmentVariables["npm_config_update_notifier"] = "false";
        return info;
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void OpenBrowser()
    {
        Process.Start(new ProcessStartInfo(Address) { UseShellExecute = true });
    }

    private static void ShowMessage(string message, string title, MessageBoxIcon icon)
    {
        MessageBox.Show(message, title, MessageBoxButtons.OK, icon);
    }

    private static void WriteLog(string message)
    {
        AppendLine(logFile, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message);
    }

    private static void AppendLine(string path, string line)
    {
        try
        {
            lock (LogLock) File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
    }

    private sealed class TimedWebClient : WebClient
    {
        protected override WebRequest GetWebRequest(Uri address)
        {
            WebRequest request = base.GetWebRequest(address);
            request.Timeout = 180000;
            HttpWebRequest httpRequest = request as HttpWebRequest;
            if (httpRequest != null) httpRequest.ReadWriteTimeout = 180000;
            return request;
        }
    }
}
