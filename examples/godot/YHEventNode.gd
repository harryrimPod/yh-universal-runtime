extends Node
class_name YHEventNode

## Godot 4 WebSocket consumer for the YH bridge. Attach this script to a Node,
## set target_path to the visual Node3D, and optionally call send_control().
## It reconnects automatically, restores the target's scale when it leaves the
## tree, and re-emits every bridge event through signals so other scripts
## (for example YHAnimationBinder) can react without opening another socket.

signal level_received(value: float, source_id: String)
signal onset_received(value: float, source_id: String)
signal event_received(address: String, value: float, source_id: String)
signal connection_changed(up: bool)
## Emitted for both a lost connection and a stale /yh/level stream.
signal level_released

@export var endpoint := "ws://127.0.0.1:8765/ws"
## Only needed when the bridge runs with YH_TOKEN.
@export var token := ""
## Label attached to frames sent with send_control().
@export var source_id := "godot"
## When not empty, only events from this bridge sourceId are used.
@export var source_filter := ""
@export var auto_reconnect := true
## Treat the bridge as gone after this many ms without a frame (it sends heartbeats). 0 disables.
@export var stale_ms := 8000
## When > 0, ease back to rest if no /yh/level arrives for this many ms. 0 holds the last value.
## Losing the connection always eases back to rest.
@export var level_stale_ms := 0
## In "relative" mode, treat a scale written by someone else (AnimationPlayer, script) as the new rest pose.
@export var follow_external_scale := true
@export var target_path: NodePath
## "relative" keeps the target's own scale as the rest pose; "absolute" sets a uniform scale.
@export_enum("relative", "absolute") var scale_mode := "relative"
@export var min_scale := 0.68
@export var max_scale := 1.75
@export var onset_boost := 0.6
@export var decay_rate := 3.2
@export_range(0.0, 1.0, 0.01) var level_threshold := 0.18
@export_range(0.0, 1.0, 0.01) var level_release_threshold := 0.12
@export var level_attack_ms := 120.0
@export var level_release_ms := 180.0
@export var level_smoothing := 8.0
@export_range(0.0, 1.0, 0.01) var rest_level := 0.42

var socket := WebSocketPeer.new()
var target: Node3D
var original_scale := Vector3.ONE
var rest_scale := 1.0
var level := 0.42
var level_target := 0.42
var level_response := 0.42
var level_active := false
var level_above_since_ms := -1
var level_below_since_ms := -1
var pulse := 0.0
var base_scale := 1.0
var connected := false
var reconnect_at_ms := 0
var reconnect_attempt := 0
var last_frame_ms := 0
var last_level_ms := -1
var stale_released := false
var has_written := false
var last_written_scale := Vector3.ONE

func _ready() -> void:
    if not target_path.is_empty():
        target = get_node_or_null(target_path) as Node3D
        if target == null:
            push_warning("YHEventNode: target_path '%s' is not a Node3D; no object will be driven" % target_path)
    level = rest_level
    level_target = rest_level
    level_response = rest_level
    rest_scale = maxf(min_scale + rest_level * (max_scale - min_scale), 0.0001)
    base_scale = rest_scale
    if target:
        original_scale = target.scale
    _apply_scale()
    _open_socket()

func _open_socket() -> void:
    socket = WebSocketPeer.new()
    var url := endpoint
    if token != "":
        url += ("&" if "?" in endpoint else "?") + "token=" + token.uri_encode()
    var err := socket.connect_to_url(url)
    if err != OK:
        push_error("YH WebSocket connect failed: %s" % err)

func _process(delta: float) -> void:
    socket.poll()
    var state := socket.get_ready_state()
    var now_ms := Time.get_ticks_msec()
    if state == WebSocketPeer.STATE_OPEN:
        if not connected:
            connected = true
            reconnect_attempt = 0
            last_frame_ms = now_ms
            connection_changed.emit(true)
        while socket.get_available_packet_count() > 0:
            last_frame_ms = now_ms
            _handle_frame(socket.get_packet().get_string_from_utf8())
        if stale_ms > 0 and now_ms - last_frame_ms > stale_ms:
            socket.close()
    elif state == WebSocketPeer.STATE_CLOSED:
        if connected:
            connected = false
            release_to_rest()
            connection_changed.emit(false)
        _maybe_reconnect(now_ms)

    if level_stale_ms > 0 and last_level_ms >= 0 and not stale_released and now_ms - last_level_ms > level_stale_ms:
        stale_released = true
        release_to_rest()

    var safe_delta := maxf(0.0, delta)
    pulse *= exp(-decay_rate * safe_delta)
    if pulse < 0.002:
        pulse = 0.0
    var response_alpha := 1.0 - exp(-maxf(0.0, level_smoothing) * safe_delta)
    level_response = lerpf(level_response, level_target, response_alpha)
    if absf(level_target - level_response) < 0.000001:
        level_response = level_target
    base_scale = min_scale + level_response * (max_scale - min_scale)
    _apply_scale()

func _maybe_reconnect(now_ms: int) -> void:
    if not auto_reconnect:
        return
    if reconnect_at_ms == 0:
        reconnect_at_ms = now_ms + int(minf(5000.0, 250.0 * pow(2.0, reconnect_attempt)))
        reconnect_attempt += 1
    elif now_ms >= reconnect_at_ms:
        reconnect_at_ms = 0
        _open_socket()

func _handle_frame(text: String) -> void:
    var frame = JSON.parse_string(text)
    if typeof(frame) != TYPE_DICTIONARY:
        return
    if frame.get("kind", "") != "osc":
        return
    var args = frame.get("args", [])
    if args.is_empty() or typeof(args[0]) not in [TYPE_FLOAT, TYPE_INT]:
        return
    var frame_source := str(frame.get("sourceId", ""))
    if source_filter != "" and frame_source != source_filter:
        return
    var value := float(args[0])
    var address := str(frame.get("address", ""))
    match address:
        "/yh/level":
            _set_level(value)
            level_received.emit(value, frame_source)
        "/yh/onset":
            pulse = maxf(pulse, clampf(value, 0.0, 1.0))
            _apply_scale()
            onset_received.emit(value, frame_source)
    event_received.emit(address, value, frame_source)

## Eases the level response back to rest, e.g. when the event stream is lost.
func release_to_rest() -> void:
    level_active = false
    level_above_since_ms = -1
    level_below_since_ms = -1
    level = rest_level
    level_target = rest_level
    level_released.emit()

func _set_level(value: float) -> void:
    level = clampf(value, 0.0, 1.0)
    var now_ms := Time.get_ticks_msec()
    last_level_ms = now_ms
    stale_released = false
    var safe_threshold := clampf(level_threshold, 0.0, 0.999999)
    var safe_release_threshold := minf(safe_threshold, clampf(level_release_threshold, 0.0, 1.0))
    if not level_active:
        level_below_since_ms = -1
        if level >= safe_threshold:
            if level_above_since_ms < 0:
                level_above_since_ms = now_ms
            if now_ms - level_above_since_ms >= level_attack_ms:
                level_active = true
                level_above_since_ms = -1
        else:
            level_above_since_ms = -1
    else:
        level_above_since_ms = -1
        if level <= safe_release_threshold:
            if level_below_since_ms < 0:
                level_below_since_ms = now_ms
            if now_ms - level_below_since_ms >= level_release_ms:
                level_active = false
                level_below_since_ms = -1
        else:
            level_below_since_ms = -1

    if level_active:
        var amount := clampf((level - safe_threshold) / (1.0 - safe_threshold), 0.0, 1.0)
        level_target = rest_level + amount * (1.0 - rest_level)
    else:
        level_target = rest_level

func send_control(address: String, value: float) -> Error:
    if socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
        return ERR_UNAVAILABLE
    var frame := {"kind": "control", "address": address, "value": value}
    if source_id != "":
        frame["source"] = source_id
    return socket.send_text(JSON.stringify(frame))

func _apply_scale() -> void:
    if not is_instance_valid(target):
        return
    var scale_now := base_scale + onset_boost * pulse
    if scale_mode == "absolute":
        target.scale = Vector3.ONE * scale_now
        return
    if _modified_externally():
        original_scale = target.scale
    target.scale = original_scale * (scale_now / rest_scale)
    last_written_scale = target.scale
    has_written = true

func _modified_externally() -> bool:
    return scale_mode == "relative" and follow_external_scale and has_written \
        and not target.scale.is_equal_approx(last_written_scale)

func _exit_tree() -> void:
    if is_instance_valid(target) and not _modified_externally():
        target.scale = original_scale
    socket.close(1000, "scene exiting")
