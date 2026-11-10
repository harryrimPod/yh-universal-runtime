import { YHScaleAdapter } from './scale-core.js';

/** Verge3D exposes THREE-compatible Object3D.scale (a Vector3 with set(x,y,z)). */
export class YHVerge3DAdapter extends YHScaleAdapter {
  constructor(client, object3D, options) {
    if (!client || !object3D?.scale?.set) throw new TypeError('YHVerge3DAdapter needs a YHEventClient and a Verge3D Object3D');
    super(client, object3D.scale, options);
    this.object = object3D;
  }
}
