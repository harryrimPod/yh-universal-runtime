extends Node3D

const EventNodeScript := preload("res://YHEventNode.gd")
const BinderScript := preload("res://YHAnimationBinder.gd")

var target: Node3D
var player: AnimationPlayer
var event_node: Node
var binder: Node
var elapsed := 0.0
var send_timer := 0.0
var stage := 0
var failed := false

func _ready() -> void:
    target = Node3D.new()
    target.name = "Target"
    add_child(target)

    var animation := Animation.new()
    animation.length = 1.0
    var track := animation.add_track(Animation.TYPE_VALUE)
    animation.track_set_path(track, NodePath("Target:position:y"))
    animation.track_insert_key(track, 0.0, 0.0)
    animation.track_insert_key(track, 1.0, 2.0)
    var library := AnimationLibrary.new()
    library.add_animation("Pulse", animation)
    player = AnimationPlayer.new()
    player.name = "Player"
    add_child(player)
    player.add_animation_library("", library)

    event_node = EventNodeScript.new()
    event_node.name = "Event"
    event_node.source_id = "godot-test"
    add_child(event_node)

    binder = BinderScript.new()
    binder.name = "Binder"
    binder.event_node_path = NodePath("../Event")
    binder.player_path = NodePath("../Player")
    binder.onset_animation = "Pulse"
    binder.level_speed_enabled = true
    binder.speed_min = 0.5
    binder.speed_max = 2.0
    add_child(binder)

func _process(delta: float) -> void:
    elapsed += delta
    send_timer += delta
    if event_node.connected and send_timer >= 0.1:
        send_timer = 0.0
        match stage:
            0:
                event_node.send_control("/yh/level", 1.0)
            1:
                event_node.send_control("/yh/onset", 1.0)
            3:
                event_node.send_control("/yh/level", 0.0)
    match stage:
        0:
            if is_equal_approx(player.speed_scale, 2.0):
                stage = 1
        1:
            if binder.triggered_count >= 1:
                stage = 2
        2:
            if player.is_playing() and target.position.y > 0.1:
                stage = 3
        3:
            if is_equal_approx(player.speed_scale, 0.5):
                print("GODOT YH BINDER TEST: PASS — onset played the AnimationPlayer clip and level drove its speed")
                get_tree().quit(0)
    if elapsed > 8.0 and not failed:
        failed = true
        push_error("GODOT YH BINDER TEST: FAIL — stage %d, speed_scale=%s, triggered=%s, y=%s" % [stage, player.speed_scale, binder.triggered_count, target.position.y])
        get_tree().quit(1)
