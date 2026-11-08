import { spawn } from "node:child_process";

/**
 * Agrandit la fenêtre de l'application installée (Brave : titre exact ; Firefox : « <titre> — … dans
 * Mozilla Firefox ») comme le bouton « Agrandir » de Windows : le navigateur ne la rouvre pas toujours agrandie.
 * Résout sans erreur si rien n'est trouvé (ou hors de Windows).
 */
export function maximizeAppWindow(title: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Fenetres {
  public delegate bool Visite(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visite f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int etat);
}
'@
$titre = $env:SECOND_CERVEAU_TITRE
[void][Fenetres]::EnumWindows({
  param($h, $l)
  $texte = New-Object System.Text.StringBuilder 256
  [void][Fenetres]::GetWindowText($h, $texte, 256)
  if ($texte.ToString() -eq $titre -and [Fenetres]::IsWindowVisible($h)) {
    $processus = 0
    [void][Fenetres]::GetWindowThreadProcessId($h, [ref]$processus)
    if ((Get-Process -Id $processus -ErrorAction SilentlyContinue).ProcessName -eq 'brave') { [void][Fenetres]::ShowWindow($h, 3) }
  } elseif ($texte.ToString().EndsWith(' ' + $titre + ' dans Mozilla Firefox') -and [Fenetres]::IsWindowVisible($h)) {
    # Application installée par Firefox (« Applications web de Firefox ») : « <page> — <app> dans Mozilla Firefox ».
    [void][Fenetres]::ShowWindow($h, 3)
  }
  $true
}, [IntPtr]::Zero)
`;
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: { ...process.env, SECOND_CERVEAU_TITRE: title },
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}
