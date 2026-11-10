import { YHScaleAdapter } from './scale-core.js';

export class YHThreeAdapter extends YHScaleAdapter {
  constructor(client, object3D, options) {
    if (!client || !object3D?.scale?.set) throw new TypeError('YHThreeAdapter needs a YHEventClient and a Three.js Object3D');
    super(client, object3D.scale, options);
    this.object = object3D;
  }
}
