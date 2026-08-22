import 'dart:convert';

import 'package:app/domain/contracts/update_checker.dart';
import 'package:app/domain/entities/update_info.dart';
import 'package:dio/dio.dart';

/// Busca o `latest.json` do app via HTTP (Dio — mesmo client já usado pelo
/// mesh, plano 24). Timeout curto; qualquer falha → `null` (nunca lança), pra
/// que o aviso seja totalmente silencioso quando offline/indisponível.
///
/// Lê o schema do `latest.json` do App, com 1 artefato `android`/`apk`.
/// O parsing/validação fica em [UpdateInfo.fromJson].
class UpdateCheckerImpl implements UpdateChecker {
  UpdateCheckerImpl({
    String? manifestUrl,
    Duration timeout = const Duration(seconds: 5),
    Dio? dio,
  })  : manifestUrl = manifestUrl ?? defaultManifestUrl,
        _dio = dio ?? _defaultDio(timeout);

  static const String defaultManifestUrl =
      'https://rp-s3.jacobmoura.work/downloads/app/latest.json';

  final String manifestUrl;
  final Dio _dio;

  static Dio _defaultDio(Duration timeout) {
    return Dio(
      BaseOptions(
        connectTimeout: timeout,
        sendTimeout: timeout,
        receiveTimeout: timeout,
        // Tratamos status não-2xx manualmente — não deixa o Dio lançar.
        validateStatus: (_) => true,
        // Plain: jsonDecode manual, não deixa o parser do Dio tropeçar num
        // corpo vazio/não-JSON num 4xx/5xx.
        responseType: ResponseType.plain,
      ),
    );
  }

  @override
  Future<UpdateInfo?> fetchLatest() async {
    try {
      final response = await _dio.getUri<Object?>(Uri.parse(manifestUrl));
      if (response.statusCode != 200) return null;
      final data = response.data;
      final body = data is String ? data : null;
      if (body == null || body.isEmpty) return null;
      return UpdateInfo.fromJson(jsonDecode(body));
    } catch (_) {
      // sem rede / 404 / JSON inválido / schema errado → silencioso.
      return null;
    }
  }
}
