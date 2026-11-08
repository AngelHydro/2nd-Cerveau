// Nombres écrits en toutes lettres (orthographe traditionnelle), pour le sous-titre manuscrit de l'accueil.

const UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize"];
const TENS = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante"];

function belowHundred(n: number): string {
  if (n <= 16) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  if (n < 70) {
    const tens = TENS[Math.floor(n / 10)];
    const unit = n % 10;
    if (unit === 0) return tens;
    return unit === 1 ? `${tens} et un` : `${tens}-${UNITS[unit]}`;
  }
  if (n < 80) return n === 71 ? "soixante et onze" : `soixante-${belowHundred(n - 60)}`;
  if (n === 80) return "quatre-vingts";
  return `quatre-vingt-${belowHundred(n - 80)}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const restText = rest ? belowHundred(rest) : "";
  if (!hundreds) return restText;
  const head = hundreds === 1 ? "cent" : `${UNITS[hundreds]} cent${rest ? "" : "s"}`;
  return rest ? `${head} ${restText}` : head;
}

/** 1330 → « mille trois cent trente » (jusqu'à 999 999 ; au-delà, chiffres). */
export function numberToFrench(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return n.toLocaleString("fr-FR");
  if (n < 1000) return belowThousand(n);
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  // « mille » est invariable, et « vingts » / « cents » perdent leur s devant lui.
  const head = thousands === 1 ? "mille" : `${belowThousand(thousands).replace(/(vingt|cent)s$/, "$1")} mille`;
  return rest ? `${head} ${belowThousand(rest)}` : head;
}
