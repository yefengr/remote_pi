/// Manifest de release (`latest.json` na VPS) — contrato com o CI/Site.
///
/// Schema do App (com 1 artefato Android):
/// ```json
/// {
///   "version": "1.1.0",
///   "date": "2026-06-12",
///   "notes": "…",
///   "artifacts": [
///     { "platform": "android", "arch": "universal", "format": "apk",
///       "url": "…/RemotePi.apk", "sha256": "…", "size": 0 }
///   ]
/// }
/// ```
class UpdateInfo {
  const UpdateInfo({
    required this.version,
    required this.date,
    required this.notes,
    required this.artifacts,
  });

  final String version;
  final String date;
  final String notes;
  final List<UpdateArtifact> artifacts;

  /// Parseia o manifest. **Lança** `FormatException` se o shape estiver errado
  /// (campos obrigatórios ausentes/tipo errado) — o checker trata como "sem
  /// atualização" e silencia.
  factory UpdateInfo.fromJson(Object? json) {
    if (json is! Map) {
      throw const FormatException('manifest não é um objeto JSON');
    }
    final version = json['version'];
    if (version is! String || version.isEmpty) {
      throw const FormatException('campo "version" inválido');
    }
    final rawArtifacts = json['artifacts'];
    if (rawArtifacts is! List) {
      throw const FormatException('campo "artifacts" inválido');
    }
    return UpdateInfo(
      version: version,
      date: json['date'] is String ? json['date'] as String : '',
      notes: json['notes'] is String ? json['notes'] as String : '',
      artifacts: rawArtifacts
          .map(UpdateArtifact.fromJson)
          .toList(growable: false),
    );
  }

  /// Artefato que casa com [platform] + [format], preferindo [arch]. O APK do
  /// Android é `universal`, então o arch casa direto. `null` se não houver
  /// match (a UI cai pro fallback da página de download).
  UpdateArtifact? artifactFor({
    required String platform,
    required String format,
    required String arch,
  }) {
    final matches = artifacts.where(
      (a) => a.platform == platform && a.format == format,
    );
    if (matches.isEmpty) return null;
    for (final a in matches) {
      if (a.arch == arch) return a;
    }
    // Sem match exato de arch → primeiro do formato.
    return matches.first;
  }
}

class UpdateArtifact {
  const UpdateArtifact({
    required this.platform,
    required this.arch,
    required this.format,
    required this.url,
    required this.sha256,
    required this.size,
  });

  final String platform;
  final String arch;
  final String format;
  final String url;
  final String sha256;
  final int size;

  factory UpdateArtifact.fromJson(Object? json) {
    if (json is! Map) {
      throw const FormatException('artifact não é um objeto JSON');
    }
    final url = json['url'];
    final platform = json['platform'];
    final format = json['format'];
    if (url is! String || platform is! String || format is! String) {
      throw const FormatException('artifact com campos obrigatórios inválidos');
    }
    return UpdateArtifact(
      platform: platform,
      arch: json['arch'] is String ? json['arch'] as String : '',
      format: format,
      url: url,
      sha256: json['sha256'] is String ? json['sha256'] as String : '',
      size: json['size'] is num ? (json['size'] as num).toInt() : 0,
    );
  }
}
