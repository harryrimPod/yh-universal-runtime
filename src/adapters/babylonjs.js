import { YHScaleAdapter } from './scale-core.js';

export class YHBabylonAdapter extends YHScaleAdapter {
  constructor(client, mesh, options) {
    if (!client || !mesh?.scaling?.set) throw new TypeError('YHBabylonAdapter needs a YHEventClient and a Babylon.js Mesh');
    super(client, mesh.scaling, options);
    this.mesh = mesh;
  }
}
