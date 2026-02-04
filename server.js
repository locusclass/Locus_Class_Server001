// ignore_for_file: deprecated_member_use
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/io.dart';
import '../models/presence_address.dart';
import 'media_engine.dart';
import 'voice_processor.dart';

/* ───────────────── CROSS-VERSION TYPES ───────────────── */

enum MomentReadiness { idle, waiting, alive, reconnecting }
enum PresencePhase { idle, armed, waiting }
enum PeerObstructionCause { appLostFocus, attentionLost, peerObstructed }

class MomentEngineState {
  final MomentReadiness readiness;
  final String? collapseReason;
  const MomentEngineState(this.readiness, [this.collapseReason]);
}

class PeerObstructionState {
  final PeerObstructionCause cause;
  final int secondsLeft;
  const PeerObstructionState({required this.cause, required this.secondsLeft});
}

/* ───────────────── GLOBAL PROVIDERS ───────────────── */

final peerObstructionProvider = StateProvider<PeerObstructionState?>((_) => null);
final dashboardProvider = StateProvider<List<PresenceAddress>>((ref) => []);
final presenceLockProvider = StateProvider<bool>((_) => false);
final momentEngineProvider = StateNotifierProvider<MomentEngine, MomentEngineState>((ref) => MomentEngine(ref));

/* ───────────────── THE ENGINE ───────────────── */

class MomentEngine extends StateNotifier<MomentEngineState> with WidgetsBindingObserver {
  final Ref ref;
  static const String _storageKey = "presence_minted_registry";
  static const _lifecycle = MethodChannel('presence/lifecycle');
  static const String _prodUrl = 'wss://locusclassserver001-production.up.railway.app';

  MomentEngine(this.ref) : super(const MomentEngineState(MomentReadiness.idle)) {
    WidgetsBinding.instance.addObserver(this);
    _initPersistence();
    _bindNativeLifecycle();
  }

  WebSocketChannel? _ws;
  Timer? _heartbeat;
  Timer? _graceTimer;
  int _retryCount = 0;
  bool _isExplicitShutdown = false;
  static const Duration _grace = Duration(seconds: 10);

  String? _activeAddress;
  String? _activeNickname;
  String? _remoteNickname;
  List<String> _myReservedIds = [];
  bool _attentionExempted = false;
  final _rand = math.Random.secure();

  // Callbacks
  void Function(String)? onRemoteText;
  void Function(bool)? onRemoteHold;
  void Function()? onRemoteClear;
  void Function(int)? onPeerObstructed;
  void Function()? onPeerRestored;
  void Function(Uint8List, int, int)? onRevealFrame;

  /* ───────────────── RESTORED GETTERS ───────────────── */

  bool get attentionExempted => _attentionExempted;
  List<String> get myReservedIds => _myReservedIds;
  String? get remoteNickname => _remoteNickname;

  /* ───────────────── CORE LOGIC ───────────────── */

  static Map<String, dynamic> _parseBackground(String raw) => jsonDecode(raw);

  Future<void> declarePresence(String address) async {
    if (ref.read(presenceLockProvider)) return;
    _activeAddress = address;
    _isExplicitShutdown = false;
    _retryCount = 0;
    _reset(soft: false);
    state = const MomentEngineState(MomentReadiness.waiting);
    await _connect();
  }

  Future<void> _connect() async {
    if (_activeAddress == null || _isExplicitShutdown) return;
    final uri = Uri.parse('$_prodUrl?address=$_activeAddress');
    
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
      client.badCertificateCallback = (cert, host, port) => true; 
        
      final WebSocket socket = await WebSocket.connect(uri.toString(), customClient: client);
      _ws = IOWebSocketChannel(socket);

      _ws!.stream.listen(
          (data) async {
            _retryCount = 0;
            final Map<String, dynamic> msg = await compute(_parseBackground, data as String);
            _handleMessage(msg);
          },
          onDone: () => _handleDisconnect(),
          onError: (e) => _handleDisconnect(),
          cancelOnError: true
      );

      _heartbeat?.cancel();
      _heartbeat = Timer.periodic(const Duration(seconds: 8), (_) => sendSignal({'type': 'ping'}));
      sendSignal({'type': 'join', 'address': _activeAddress, 'nickname': _activeNickname});
    } catch (e) { _handleDisconnect(); }
  }

  void _handleDisconnect() {
    if (_isExplicitShutdown) return;
    state = const MomentEngineState(MomentReadiness.reconnecting);
    _ws?.sink.close();
    
    _retryCount++;
    final delay = math.min(math.pow(2, _retryCount).toInt(), 20); 
    Timer(Duration(seconds: delay), () {
      if (!_isExplicitShutdown) _connect();
    });
  }

  void _handleMessage(Map<String, dynamic> msg) async {
    if (_isExplicitShutdown) return;

    if (msg['nickname'] != null && msg['nickname'] != _activeNickname) {
      _remoteNickname = msg['nickname'];
      state = MomentEngineState(state.readiness, state.collapseReason);
    }

    final media = ref.read(mediaEngineProvider.notifier);

    switch (msg['type']) {
      case 'ready':
        ref.read(presenceLockProvider.notifier).state = true;
        final isPolite = msg['role'] == 'polite';
        media.setPolite(isPolite);
        await media.warmUpMedia();
        if (!isPolite) await media.maybeMakeOffer();
        state = const MomentEngineState(MomentReadiness.alive);
        break;
      case 'webrtc_offer': await media.handleRemoteOffer(msg); break;
      case 'webrtc_answer': await media.handleRemoteAnswer(msg); break;
      case 'webrtc_ice': await media.addIceCandidate(msg); break;
      case 'text': onRemoteText?.call(msg['text'] ?? ''); break;
      case 'hold': onRemoteHold?.call(msg['holding'] == true); break;
      case 'clear': onRemoteClear?.call(); break;
      case 'reveal_frame':
        if (onRevealFrame != null) {
          final data = base64Decode(msg['data']);
          onRevealFrame!(data, msg['width'], msg['height']);
        }
        break;
      case 'peer_obstructed': _enterSoftObstruction('peer_obstructed', seconds: msg['seconds'], notifyPeer: false); break;
      case 'peer_restored': _exitSoftObstruction(notifyPeer: false); break;
      case 'collapse': 
        _isExplicitShutdown = true;
        _collapseHard(msg['reason'] ?? 'remote_end'); 
        break;
    }
  }

  /* ───────────────── INTERFACE METHODS ───────────────── */

  void syncVoiceProfile(VoiceProfile profile) {
    if (_isExplicitShutdown || _ws == null) return;
    sendSignal({'type': 'voice_mask_update', 'profile': profile.name});
    ref.read(mediaEngineProvider.notifier).setVoiceProfile(profile);
  }

  void sendWebRTCSignal(Map<String, dynamic> signal) => sendSignal(signal);

  void collapseImmediatelyByUser() {
    _isExplicitShutdown = true;
    sendSignal({'type': 'collapse', 'reason': 'user_terminated'});
    _collapseHard('user_terminated');
  }

  /* ───────────────── PERSISTENCE ───────────────── */

  Future<void> _initPersistence() async {
    final prefs = await SharedPreferences.getInstance();
    _myReservedIds = prefs.getStringList(_storageKey) ?? [];
    final List<PresenceAddress> loaded = [];
    for (var id in _myReservedIds) {
      final nick = prefs.getString("${_storageKey}_nick_$id") ?? "MINTED";
      loaded.add(PresenceAddress(id: id, nickname: nick, remainingTime: "24H"));
    }
    ref.read(dashboardProvider.notifier).state = loaded;
  }

  void reservePresence({required String nickname, required int hours}) async {
    final id = _generateSystemAddress();
    final addr = PresenceAddress(id: id, nickname: nickname.toUpperCase(), remainingTime: "${hours}H");
    ref.read(dashboardProvider.notifier).update((c) => [...c, addr]);
    _myReservedIds.add(id);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_storageKey, _myReservedIds);
    await prefs.setString("${_storageKey}_nick_$id", nickname.toUpperCase());
  }

  void deletePresence(String id) async {
    _myReservedIds.remove(id);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_storageKey, _myReservedIds);
    await prefs.remove("${_storageKey}_nick_$id");
    ref.read(dashboardProvider.notifier).update((c) => c.where((a) => a.id != id).toList());
  }

  void joinFromRegistry(String address, String nickname) {
    _activeNickname = nickname.toUpperCase();
    declarePresence(address);
  }

  /* ───────────────── HELPERS ───────────────── */

  void sendSignal(Map<String, dynamic> payload) {
    if (_isExplicitShutdown || _ws == null) return;
    if (_activeNickname != null) payload['nickname'] = _activeNickname;
    _ws!.sink.add(jsonEncode(payload));
  }

  void _collapseHard(String reason) {
    _reset(soft: false);
    state = MomentEngineState(MomentReadiness.idle, reason);
  }

  void _reset({bool soft = true}) {
    _heartbeat?.cancel();
    _ws?.sink.close();
    if (!soft) {
      ref.read(mediaEngineProvider.notifier).disposeMedia();
      ref.read(presenceLockProvider.notifier).state = false;
      _remoteNickname = null;
    }
  }

  String _generateSystemAddress() =>
      ['B','C','D','F','G','H','J','K','L','M','N','P','R','S','T','V','W','Y','Z'][_rand.nextInt(19)] +
          ['A', 'E', 'I', 'U'][_rand.nextInt(4)] +
          ['B','C','D','F','G','H','J','K','L','M','N','P','R','S','T','V','W','Y','Z'][_rand.nextInt(19)] +
          (_rand.nextInt(900) + 100).toString();

  /* ───────────────── LIFECYCLE ───────────────── */

  void _enterSoftObstruction(String reason, {int? seconds, bool notifyPeer = true}) {
    if (_isExplicitShutdown || _attentionExempted || _graceTimer != null) return;
    final int s = seconds ?? _grace.inSeconds;
    onPeerObstructed?.call(s);
    ref.read(peerObstructionProvider.notifier).state = PeerObstructionState(
        cause: reason == 'app_lost_focus' ? PeerObstructionCause.appLostFocus : PeerObstructionCause.attentionLost,
        secondsLeft: s
    );
    if (notifyPeer) sendSignal({'type': 'peer_obstructed', 'seconds': s, 'reason': reason});
    _graceTimer = Timer(Duration(seconds: s), () => _collapseHard('grace_expired'));
  }

  void _exitSoftObstruction({bool notifyPeer = true}) {
    if (_graceTimer == null) return;
    _graceTimer?.cancel(); _graceTimer = null;
    onPeerRestored?.call();
    ref.read(peerObstructionProvider.notifier).state = null;
    if (notifyPeer) sendSignal({'type': 'peer_restored'});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _exitSoftObstruction();
    else if (state == AppLifecycleState.paused) _enterSoftObstruction('app_lost_focus');
  }

  void _bindNativeLifecycle() {
    _lifecycle.setMethodCallHandler((call) async {
      switch (call.arguments as String) {
        case 'attention_lost': _enterSoftObstruction('attention_lost'); break;
        case 'attention_restored': _exitSoftObstruction(); break;
        case 'attention_exempted': _attentionExempted = true; _exitSoftObstruction(); break;
        case 'attention_exemption_cleared': _attentionExempted = false; break;
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _isExplicitShutdown = true;
    _reset(soft: false);
    super.dispose();
  }
}
