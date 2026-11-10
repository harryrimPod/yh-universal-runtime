extends Node
class_name YHAnimationBinder

## Maps YH events to an AnimationPlayer. Needs a YHEventNode (it only listens to
## that node's signals) and an AnimationPlayer; both are found by NodePath.
##  - /yh/onset            -> restarts onset_animation
##  - /yh/level            -> player.speed_scale between speed_min and speed_max (optional)
##  - level gate           -> gate_enter_animation / gate_exit_animation with hysteresis (optional)
##  - add_trigger_rule()   -> any other address, e.g. "/yh/band/low"

@export var event_node_path: NodePath
@export var player_path: NodePath
@export var onset_animation := ""
@export_range(0.0, 1.0, 0.01) var onset_min_value := 0.5
@export var onset_cooldown_ms := 250
@export var level_speed_enabled := false
@export var speed_min := 0.5
@export var speed_max := 2.0
## <= 0 disables the gate.
@export_range(-1.0, 1.0, 0.01) var gate_threshold := -1.0
@export_range(0.0, 1.0, 0.01) var gate_release_threshold := 0.0
@export var gate_enter_animation := ""
@export var gate_exit_animation := ""

var event_node: Node
var player: AnimationPlayer
var trigger_rules: Array[Dictionary] = []
var gate_active := false
var triggered_count := 0
var original_speed_scale := 1.0

func _ready() -> void:
    event_node = get_node_or_null(event_node_path)
    player = get_node_or_null(player_path) as AnimationPlayer
    if event_node == null or not event_node.has_signal("event_received"):
        push_warning("YHAnimationBinder: event_node_path must point to a YHEventNode")
        return
    if player == null:
        push_warning("YHAnimationBinder: player_path must point to an AnimationPlayer")
        return
    if onset_animation != "":
        add_trigger_rule("/yh/onset", onset_animation, onset_min_value, onset_cooldown_ms)
    original_speed_scale = player.speed_scale
    event_node.event_received.connect(_on_event)
    if event_node.has_signal("level_released"):
        event_node.level_released.connect(_on_level_released)

## Losing the stream must not leave the gate "entered" or the speed stuck at the last level.
func _on_level_released() -> void:
    if gate_active:
        gate_active = false
        _play(gate_exit_animation)
    if level_speed_enabled and player != null:
        player.speed_scale = original_speed_scale

func add_trigger_rule(address: String, animation: String, min_value := 0.5, cooldown_ms := 0) -> void:
    trigger_rules.append({"address": address, "animation": animation, "min_value": min_value, "cooldown_ms": cooldown_ms, "last_ms": -1000000})

func _on_event(address: String, value: float, _source_id: String) -> void:
    var now_ms := Time.get_ticks_msec()
    for rule in trigger_rules:
        if rule["address"] != address:
            continue
        if value < float(rule["min_value"]) or now_ms - int(rule["last_ms"]) < int(rule["cooldown_ms"]):
            continue
        rule["last_ms"] = now_ms
        _play(str(rule["animation"]))
    if address != "/yh/level":
        return
    var level := clampf(value, 0.0, 1.0)
    if level_speed_enabled:
        player.speed_scale = lerpf(speed_min, speed_max, level)
    if gate_threshold > 0.0:
        var release_threshold := minf(gate_threshold, gate_release_threshold if gate_release_threshold > 0.0 else gate_threshold * 0.7)
        if not gate_active and level >= gate_threshold:
            gate_active = true
            _play(gate_enter_animation)
        elif gate_active and level <= release_threshold:
            gate_active = false
            _play(gate_exit_animation)

func _play(animation: String) -> bool:
    if animation == "" or player == null or not player.has_animation(animation):
        return false
    player.stop()
    player.play(animation)
    triggered_count += 1
    return true
