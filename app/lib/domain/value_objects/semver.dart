/// Comparação de versões semver simples `x.y.z` — numérica por componente.
///
/// Ignora sufixos de pré-release/build (`-beta`, `+1`): considera só os três
/// primeiros componentes numéricos. Componentes ausentes contam como 0
/// (`1.2` == `1.2.0`); não-numéricos contam como 0. A versão é usada para
/// comparar a versão instalada com a do `latest.json` do App.
library;

List<int> _parse(String v) {
  // Tira qualquer coisa depois de `-` ou `+` (pré-release / build metadata).
  final core = v.trim().split(RegExp(r'[-+]')).first;
  final parts = core.split('.');
  return List<int>.generate(3, (i) {
    if (i >= parts.length) return 0;
    return int.tryParse(parts[i].trim()) ?? 0;
  });
}

/// `-1` se [a] < [b], `0` se iguais, `1` se [a] > [b].
int compareSemver(String a, String b) {
  final pa = _parse(a);
  final pb = _parse(b);
  for (var i = 0; i < 3; i++) {
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/// `true` se [candidate] é uma versão **maior** que [current].
bool isNewerVersion(String candidate, String current) =>
    compareSemver(candidate, current) > 0;
