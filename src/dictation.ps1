param(
    [ValidateSet('Info', 'Listen')][string]$Mode = 'Info',
    [string]$RecognizerId,
    [string]$InputFile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -AssemblyName System.Speech
    $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
    if ($Mode -eq 'Info') {
        $languages = @($recognizers | ForEach-Object {
            [pscustomobject]@{ id = $_.Id; culture = $_.Culture.Name; name = $_.Culture.DisplayName }
        })
        [Console]::WriteLine((@{ type = 'info'; languages = $languages } | ConvertTo-Json -Compress -Depth 4))
        exit 0
    }

    if (!$RecognizerId -and $recognizers.Count) { $RecognizerId = $recognizers[0].Id }
    if (!($recognizers | Where-Object { $_.Id -eq $RecognizerId })) { throw 'The selected Windows speech recognizer is unavailable.' }
    Add-Type -AssemblyName System.Web.Extensions
    Add-Type -ReferencedAssemblies @(
        [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location,
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
    ) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;
using System.Web.Script.Serialization;

public static class HarnessDictation {
    private static readonly object OutputLock = new object();
    private static void Write(object value) {
        lock (OutputLock) {
            Console.WriteLine(new JavaScriptSerializer().Serialize(value));
            Console.Out.Flush();
        }
    }

    public static void Run(string recognizerId, string inputFile) {
        using (var recognizer = new SpeechRecognitionEngine(recognizerId))
        using (var done = new ManualResetEvent(false)) {
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs args) {
                Write(new { type = "text", text = args.Result.Text, confidence = args.Result.Confidence });
            };
            recognizer.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs args) {
                if (args.Error != null) Write(new { type = "error", message = args.Error.Message });
                done.Set();
            };
            if (String.IsNullOrEmpty(inputFile)) recognizer.SetInputToDefaultAudioDevice();
            else recognizer.SetInputToWaveFile(inputFile);
            recognizer.RecognizeAsync(RecognizeMode.Multiple);
            Write(new { type = "ready", culture = recognizer.RecognizerInfo.Culture.Name });

            var commands = new Thread(delegate() {
                try {
                    string command = Console.ReadLine();
                    if (command == "stop") recognizer.RecognizeAsyncStop();
                    else recognizer.RecognizeAsyncCancel();
                } catch (ObjectDisposedException) { }
                  catch (InvalidOperationException) { }
            });
            commands.IsBackground = true;
            commands.Start();
            done.WaitOne();
        }
    }
}
'@
    [HarnessDictation]::Run($RecognizerId, $InputFile)
} catch {
    [Console]::WriteLine((@{ type = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
