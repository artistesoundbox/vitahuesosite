import * as THREE from 'three';

/** Frame-rate independent angular damping, shortest path around the circle. */
export function dampAngle(current, target, lambda, dt) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

export function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function randRange(min, max) {
  return min + Math.random() * (max - min);
}
