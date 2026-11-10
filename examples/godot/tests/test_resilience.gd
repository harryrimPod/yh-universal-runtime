extends Node3D

# 1) With level_stale_ms set, a level stream that stops lets the target ease back to its rest scale.
# 2) A scale written by someone else becomes the new rest pose instead of being overwritten.

const EventNodeScript := preload("res://YHEventNode.gd")
const BinderScript := preload("res://YHAnimationBinder.gd")

var target: Node3D
var event_node: Node
var player: AnimationPlayer
var binder: Node
var elapsed := 0.0
var send_timer := 0.0
var stage := 0
var stage_started := 0.0
var failed := false

func _ready() -> void:
    target = Node3D.new()
    target.name = "Target"
    target.scale = Vector3(2.0, 1.0, 1.0)
    add_child(target)
    event_node = EventNodeScript.new()
    event_node.name = "Event"
    event_node.target_path = NodePath("../Target")
    event_node.level_stale_ms = 300
    add_child(event_node)

    var library := AnimationLibrary.new()
    for animation_name in ["Enter", "Exit"]:
        var animation := Animation.new()
        animation.length = 0.2
        library.add_animation(animation_name, animation)
    player = AnimationPlayer.new()
    player.name = "Player"
    add_child(player)
    player.add_animation_library("", library)

    binder = BinderScript.new()
    binder.name = "Binder"
    binder.event_node_path = NodePath("../Event")
    binder.player_path = NodePath("../Player")
    binder.level_speed_enabled = true
    binder.speed_min = 0.5
    binder.speed_max = 2.0
    binder.gate_threshold = 0.5
    binder.gate_release_threshold = 0.3
    binder.gate_enter_animation = "Enter"
    binder.gate_exit_animation = "Exit"
    add_child(binder)

func _next(stage_value: int) -> void:
    stage = stage_value
    stage_started = elapsed

func _process(delta: float) -> void:
    elapsed += delta
    send_timer += delta
    match stage:
        0:
            if event_node.connected and send_timer >= 0.05:
                send_timer = 0.0
                event_node.send_control("/yh/level", 1.0)
            if target.scale.x > 2.3 and binder.gate_active and is_equal_approx(player.speed_scale, 2.0):
                _next(1)
        1:
            # Stream stopped: scale, gate and playback speed must all return to rest.
            if absf(target.scale.x - 2.0) < 0.02 and absf(target.scale.y - 1.0) < 0.01 \
                    and not binder.gate_active and is_equal_approx(player.speed_scale, 1.0) and binder.triggered_count >= 2:
                target.scale = Vector3(4.0, 2.0, 2.0)
                _next(2)
            elif elapsed - stage_started > 4.0:
                _fail("stale release incomplete (scale=%s, gate=%s, speed=%s, triggers=%s)" % [target.scale, binder.gate_active, player.speed_scale, binder.triggered_count])
        2:
            # An external write must be adopted as the new rest pose, not reverted.
            if elapsed - stage_started > 0.3:
                if absf(target.scale.x - 4.0) < 0.05 and absf(target.scale.y - 2.0) < 0.03:
                    print("GODOT YH RESILIENCE TEST: PASS — stale level released scale, gate and speed; external scale adopted as the new rest pose")
                    get_tree().quit(0)
                else:
                    _fail("external scale was not adopted (scale=%s)" % target.scale)
    if elapsed > 10.0 and not failed:
        _fail("timed out at stage %d (scale=%s)" % [stage, target.scale])

func _fail(message: String) -> void:
    if failed:
        return
    failed = true
    push_error("GODOT YH RESILIENCE TEST: FAIL — " + message)
    get_tree().quit(1)
