var machine = function (sim, mstate, mid) {
        this.state = mstate;
        this.id = mid;
        this.x = mstate.x;
        this.y = mstate.y;
        this.z = mstate.z;
        this.sim = sim;

        this.force = [0.0, 0.0, 0.0, 0.0];
        return this;
};

machine.prototype.blockRead = function (blocks, cb) {
    for (var x = 0; x < blocks.length; ++x) {
        var cx = blocks[x][0];
        var cy = blocks[x][1];
        var cz = blocks[x][2];
        var bx = blocks[x][3];
        var by = blocks[x][4];
        var bz = blocks[x][5];
        blocks[x] = this.sim.readBlock(cx, cy, cz, bx, by, bz);
    }

    cb(blocks);
};

/*
    This add a force onto the machine which will cause
    it to move in the zone. It shall still obey any laws
    of physics.
*/
machine.prototype.forcePush = function (force) {
    this.force[0] += force[0] * force[3];
    this.force[1] += force[1] * force[3];
    this.force[2] += force[2] * force[3];
};

machine.prototype.getAvatarSocket = function () {
        return this.ws;
};

machine.prototype.attachAvatarSocket = function (ws) {
    this.ws = ws;
    this.sim.updateAvatarForMachineWithInitialState(this);
};

module.exports = machine;
