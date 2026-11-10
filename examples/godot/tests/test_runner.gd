extends Node3D

@onready var orb: Node3D = $Orb
var peer := WebSocketPeer.new()
var elapsed := 0.0
var sent := false
var got_level := false
var got_onset := false
var level_send_timer := 0.0
var level_send_count := 0
var settled_frames := 0
var failed := false

func _ready() -> void:
    var error := peer.connect_to_url("ws://127.0.0.1:8765/ws")
    if error != OK:
        _fail("connect_to_url returned %s" % error)

func _process(delta: float) -> void:
    elapsed += delta
    peer.poll()
    if peer.get_ready_state() == WebSocketPeer.STATE_OPEN and not sent and level_send_count >= 8:
        sent = true
        var onset_error := peer.send_text(JSON.stringify({"kind": "control", "address": "/yh/onset", "value": 1}))
        if onset_error != OK:
            _fail("failed to send onset control frame")
    if peer.get_ready_state() == WebSocketPeer.STATE_OPEN and level_send_count < 12:
        level_send_timer += delta
        if level_send_count == 0 or level_send_timer >= 0.025:
            level_send_timer = 0.0
            var level_error := peer.send_text(JSON.stringify({"kind": "control", "address": "/yh/level", "value": 0.73}))
            if level_error != OK:
                _fail("failed to send level control frame")
            level_send_count += 1
    while peer.get_ready_state() == WebSocketPeer.STATE_OPEN and peer.get_available_packet_count() > 0:
        var frame = JSON.parse_string(peer.get_packet().get_string_from_utf8())
        if typeof(frame) != TYPE_DICTIONARY or frame.get("kind", "") != "osc":
            continue
        var args: Array = frame.get("args", [])
        if args.is_empty():
            continue
        if frame.get("address", "") == "/yh/level" and absf(float(args[0]) - 0.73) < 0.001:
            got_level = true
        elif frame.get("address", "") == "/yh/onset" and float(args[0]) >= 1.0:
            got_onset = true
    if got_level and got_onset and level_send_count >= 10:
        settled_frames += 1
        if settled_frames >= 3:
            var expected_response := 0.42 + ((0.73 - 0.18) / (1.0 - 0.18)) * (1.0 - 0.42)
            var expected_base := 0.68 + expected_response * (1.75 - 0.68)
            var rest_scale := 0.68 + 0.42 * (1.75 - 0.68)
            # Relative scale mode: the Orb's own scale (1.0) is the rest pose, so the factor is divided by rest_scale.
            var expected_factor := (expected_base + 0.30) / rest_scale
            if orb.scale.x > expected_factor and orb.scale.x == orb.scale.y and orb.scale.y == orb.scale.z:
                print("GODOT YH SAMPLE TEST: PASS — sustained /yh/level response and independent /yh/onset pulse applied")
                get_tree().quit(0)
            else:
                _fail("events arrived, but gate or onset did not apply the expected scale (scale=%s, expected base=%s)" % [orb.scale.x, expected_base])
    if elapsed > 8.0 and not failed:
        _fail("timed out waiting for local YH bridge events")

func _fail(message: String) -> void:
    if failed:
        return
    failed = true
    push_error("GODOT YH SAMPLE TEST: FAIL — " + message)
    get_tree().quit(1)

func _exit_tree() -> void:
    peer.close(1000, "test done")
