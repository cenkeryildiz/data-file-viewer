"""Independent (scipy) MAT v5 writer for child-paging tests: a 1x250 cell and a 250-field struct. Never extension runtime code."""
import sys

import numpy as np
import scipy.io

cell = np.empty((1, 250), dtype=object)
for i in range(250):
    cell[0, i] = np.array([[i + 1]], dtype=np.int32)
scipy.io.savemat(sys.argv[1], {
    "big_cell": cell,
    "big_struct": {f"f{i + 1:03d}": np.array([[i + 1]], dtype=np.int32) for i in range(250)},
})
