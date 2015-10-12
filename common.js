
var common = {};

// 16384 units = 100 yards
// 1760 yards = 1 mile
// 24901 miles in the diameter of earth
// 1760 * 24901 * 14384 = 718041251840
//
// 16384     max-depth=0
//


/*
  This will build a list of patch indexes up to an optimal level. No zone should
  be hosted with a patch index beyond this optimal level, unless under exceptional
  circumstances. This places an upper bound on the depth. The upper bound is also
  enforced by a hard limit.

  The optimal limit is dependant on the mxyz (zone dimension uniform size) which
  can become large for very large zones (worlds). The hard limit kicks in under
  these circumstances and prevents the sub-division of the zone into patches from
  exceeding this.
*/

common.buildPatchListFromXYZ = function (x, y, z, mxyz, optimal, hard) {
  optimal = optimal || 16384;
  hard = hard || 32;

  var depth = 0;
  var out = [];

  console.log('mxyz', mxyz);
  while (
      (depth < hard) && 
      (mxyz / Math.pow(2, depth) > optimal)
  ) {
    console.log('@', depth);
    out.push(common.getPatchFromXYZD(x, y, z, mxyz, depth));
    ++depth;
  }

  return out;
}

common.getPatchesUpFromXYZD = function (patch, mxyz) {
  if (patch == null || patch == undefined) {
    throw new Error('The patch was a equiv to false.');
  }

  var r = common.XYZDFromPatch(patch, mxyz);
  var x = r[0], y = r[1], z = r[2], d = r[3];

  var out = [];

  console.log('!!', patch, x, y, z, d);

  for (; d > -1; --d) {
    var r = common.getPatchFromXYZD(x, y, z, mxyz, d);
    var patch = r[0], branch_index = r[1];
    out.push([patch, branch_index]);
  }

  return out;
};

common.XYZDFromPatch = function (patch, mxyz) {
  var base = 0;
  var depth;
  for (depth = 0; depth < 9000; ++depth) {
    var sect = Math.pow(8, depth);
    if (base + sect > patch) {
      break;
    }
    base += sect;
  }

  var divs = Math.pow(2, depth);
  var i = patch - base;
  var z = Math.floor(i / (divs * divs));
  i -= z * (divs * divs);
  var y = Math.floor(i / divs);
  i -= y * divs;
  var x = i;

  return [x, y, z, depth];
};

/*
  (index, branch_index)
*/
common.getPatchFromXYZD = function (x, y, z, mxyz, depth) {
  //x = x / Math.pow(2, depth);
  //y = y / Math.pow(2, depth);
  //z = z / Math.pow(2, depth);

  if (isNaN(x)) {
    throw new Error('[getPatchFromXYZ] DEBUG ERROR: Had NaN');
  }

  /* How many coordinate units make up a patch unit at this depth. */
  var divs = Math.pow(2, depth);
  var pupu = mxyz / divs;

  // 0 - 1
  // 1 - 2
  // 2 - 4
  // 3 - 8
  //
  //  divs = 2^0
  //  mxyz / divs = 100
  //  99 / 100 = 0
  //  
  //  100 / 2^1 = 50
  //  99 / 50 = 1
  //
  //  100 / 2^2 = 25
  //  99 / 25 = 3
  
  var px = Math.floor(x / pupu);
  var py = Math.floor(y / pupu);
  var pz = Math.floor(z / pupu);

  console.log('$', divs, pupu, px, x, y, z);

  var sx;
  var sy;
  var sz;
  if (px > px / 2) { sx = 1; } else { sx = 0; }
  if (py > py / 2) { sy = 1; } else { sy = 0; }
  if (pz > pz / 2) { sz = 1; } else { sz = 0; }

  var sxyz = sx + (sy * 2) + (sz * 2 * 2);

  var pi = px + (py * divs) + (pz * divs * divs);

  var base = 0;
  for (var x = 0; x < depth; ++x) {
    base += Math.pow(8, x);
  }
  
  return [base + pi, sxyz];
};

module.exports = common;
