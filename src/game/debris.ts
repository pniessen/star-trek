import { Color, Matrix4, Vector3 } from "three";
import type { TraceBuffer } from "../render/TraceBuffer.js";

interface Shard {
  /** Segment endpoints in local space, relative to the shard's own centre. */
  readonly a: Vector3;
  readonly b: Vector3;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly spinAxis: Vector3;
  spin: number;
  angle: number;
  life: number;
  readonly maxLife: number;
  readonly color: Color;
}

const MAX_SHARDS = 900;

/** An expanding ring marking a kill, punctuating it by the hull's own `size`. */
interface Ring {
  readonly centre: Vector3;
  readonly color: Color;
  readonly size: number;
  age: number;
}

/** How long a ring takes to expand and die. */
const RING_LIFE = 0.7;

/**
 * Ships come apart into the strokes that drew them.
 *
 * No particles, no sprites, no explosion billboard — the hull's own edge
 * segments are handed to this field, given an outward push and a tumble, and
 * left to fade. It costs nothing beyond what the ship already was, and it is
 * the single most characteristic thing a vector game can do.
 *
 * Alongside the shards, the field also carries the kill **rings** — a plain
 * expanding circle at the kill position, scaled by the hostile's own `size`
 * scalar. A Bastion popping and a Raider popping already sound and burst
 * differently; this is what makes them read differently too, without a
 * second colour or a second buffer — the ring is drawn in the class's own
 * `HOSTILE_COLORS` hue, through the same combat `TraceBuffer` as everything
 * else here.
 */
export class DebrisField {
  private readonly shards: Shard[] = [];
  private readonly rings: Ring[] = [];
  private readonly scratch = new Matrix4();
  private readonly pointA = new Vector3();
  private readonly pointB = new Vector3();
  private readonly centre = new Vector3();

  get count(): number {
    return this.shards.length;
  }

  /**
   * @param edges  flat stroke list in the object's local space
   * @param transform  the object's world matrix at the moment it died
   * @param impulse  extra velocity shared by every shard — the killing blow
   */
  burst(
    edges: readonly number[],
    transform: Matrix4,
    color: Color,
    impulse: Vector3,
    force = 1,
  ): void {
    for (let i = 0; i + 5 < edges.length; i += 6) {
      if (this.shards.length >= MAX_SHARDS) return;

      this.pointA.set(edges[i], edges[i + 1], edges[i + 2]).applyMatrix4(transform);
      this.pointB.set(edges[i + 3], edges[i + 4], edges[i + 5]).applyMatrix4(transform);
      this.centre.copy(this.pointA).add(this.pointB).multiplyScalar(0.5);

      // Outward from the hull's origin, so the shape blows apart rather than
      // scattering — you can still read what it was for the first half second.
      const outward = this.centre
        .clone()
        .sub(new Vector3().setFromMatrixPosition(transform))
        .normalize();
      if (!Number.isFinite(outward.x)) outward.set(0, 1, 0);

      const speed = (2.5 + Math.random() * 7) * force;
      this.shards.push({
        a: this.pointA.clone().sub(this.centre),
        b: this.pointB.clone().sub(this.centre),
        position: this.centre.clone(),
        velocity: outward
          .multiplyScalar(speed)
          .add(impulse)
          .add(
            new Vector3(
              (Math.random() - 0.5) * 3,
              (Math.random() - 0.5) * 2.2,
              (Math.random() - 0.5) * 3,
            ),
          ),
        spinAxis: new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
          .normalize(),
        spin: (Math.random() - 0.5) * 7,
        angle: 0,
        life: 0,
        maxLife: 1.1 + Math.random() * 1.3,
        color: color.clone(),
      });
    }
  }

  /**
   * A kill's own punctuation: an expanding ring at `centre`, in the class's
   * colour, scaled by its `size` scalar (the same 1 / 1.25 / 1.4 `destroy`
   * already computes for the burst and the blast). No pulse — it only ever
   * expands and dies, aged on `dt` like everything else here.
   */
  ring(centre: Vector3, color: Color, size: number): void {
    this.rings.push({ centre: centre.clone(), color: color.clone(), size, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const shard = this.shards[i];
      shard.life += dt;
      if (shard.life >= shard.maxLife) {
        this.shards.splice(i, 1);
        continue;
      }
      shard.position.addScaledVector(shard.velocity, dt);
      shard.velocity.addScaledVector(shard.velocity, -0.55 * dt); // drag, so it settles
      shard.angle += shard.spin * dt;
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.age += dt;
      if (ring.age >= RING_LIFE) this.rings.splice(i, 1);
    }
  }

  draw(trace: TraceBuffer): void {
    for (const shard of this.shards) {
      const remaining = 1 - shard.life / shard.maxLife;
      // Fade fast at first then linger — a dying stroke on a tube does not
      // dim linearly.
      const intensity = remaining * remaining * 1.6;

      this.scratch.makeRotationAxis(shard.spinAxis, shard.angle);
      this.pointA.copy(shard.a).applyMatrix4(this.scratch).add(shard.position);
      this.pointB.copy(shard.b).applyMatrix4(this.scratch).add(shard.position);

      trace.push(
        this.pointA.x,
        this.pointA.y,
        this.pointA.z,
        this.pointB.x,
        this.pointB.y,
        this.pointB.z,
        shard.color,
        intensity,
      );
    }

    const segments = 24;
    for (const ring of this.rings) {
      const t = ring.age / RING_LIFE;
      const radius = 2 + 22 * t;
      const intensity = 2.0 * (1 - t) * ring.size;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        trace.push(
          ring.centre.x + Math.cos(a0) * radius,
          ring.centre.y,
          ring.centre.z + Math.sin(a0) * radius,
          ring.centre.x + Math.cos(a1) * radius,
          ring.centre.y,
          ring.centre.z + Math.sin(a1) * radius,
          ring.color,
          intensity,
        );
      }
    }
  }

  clear(): void {
    this.shards.length = 0;
    this.rings.length = 0;
  }
}
