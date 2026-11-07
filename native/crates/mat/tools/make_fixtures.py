"""Independent SciPy/h5py/NumPy MAT corpus. Run with the Conda myproject Python:
    python make_fixtures.py <out-dir>
The genuine MATLAB R2026b fixtures (and their oracles) are produced by create_mat_fixtures.m and are
not regenerated here. expected.json holds what SciPy itself reads back from each Level-5 file, in the
canonical form tests/reader.rs dumps (floats as IEEE hex, integers as decimal text, text as UTF-16 units).
"""
import hashlib, json, struct, sys, zlib
from pathlib import Path
import numpy as np
import h5py
import scipy
import scipy.io as sio
import scipy.sparse as sp

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
INT64 = np.array([[-2**63], [-2**53 - 1], [0], [2**53 + 1], [2**63 - 1]], dtype=np.int64)
UINT64 = np.array([[0, 2**53 + 1, 2**64 - 1]], dtype=np.uint64)
cell = np.empty((2, 2), dtype=object, order='F')
cell[0, 0] = np.array([[7]], dtype=np.int32); cell[1, 0] = np.zeros((0, 0))
cell[0, 1] = 'literal'; cell[1, 1] = np.array([[200]], dtype=np.uint8)  # SciPy cannot tell logical from uint8; MATLAB fixtures cover logical
big = sp.csc_matrix(([5.0, -2.0], ([0, 999_999], [1, 999_999])), shape=(1_000_000, 1_000_000))
DATA = {
    'i8': np.array([[-128], [0], [127]], dtype=np.int8),
    'u8': np.array([[0, 255]], dtype=np.uint8),
    'i16': np.array([[-32768, 32767]], dtype=np.int16),
    'u16': np.array([[0, 65535]], dtype=np.uint16),
    'i32': np.arange(1, 13, dtype=np.int32).reshape(3, 4, order='F'),
    'u32': np.array([[0], [4294967295]], dtype=np.uint32),
    'i64': INT64, 'u64': UINT64,
    'f64': np.array([[0.0, -0.0, np.nan, np.inf, -np.inf, 5e-324, 1.7976931348623157e308, 0.1]]),
    'f32': np.array([[1.5, -0.0, np.nan, np.inf]], dtype=np.float32),
    'c128': np.array([[1 + 3j, 2 - 4j]]),
    'text': np.array(['abc', 'dé!']),
    'turkish': np.array(['İstanbul ığş']),
    'cube': np.arange(24, dtype=np.float64).reshape(2, 3, 4, order='F'),
    'empty_rows': np.zeros((0, 3)),
    'empty_cols': np.zeros((3, 0), dtype=np.float32),
    'cells': cell,
    'record': {'count': np.array([[1], [2]], dtype=np.int32), 'amount': np.array([[3.5], [4.5]])},
    'sparse_small': sp.csc_matrix(np.array([[0, 2.5, 0], [-1, 0, 0], [0, 0, 7]])),
}

def hexf(a):
    a = np.asarray(a)
    w = {4: ('<u4', '%08x'), 8: ('<u8', '%016x')}[a.dtype.itemsize]
    return [w[1] % int(x) for x in a.astype(a.dtype.newbyteorder('<')).reshape(-1, order='F').view(w[0])]

def canon(v):
    """Canonical dump of a loadmat value; mirrors dump() in tests/reader.rs."""
    if sp.issparse(v):
        c = v.tocsc(); c.sort_indices(); coo = c.tocoo()
        order = np.lexsort((coo.row, coo.col))
        return {'class': 'double', 'size': list(v.shape), 'sparse': True, 'nnz': int(c.nnz),
                'rows': [int(r) + 1 for r in coo.row[order]], 'cols': [int(k) + 1 for k in coo.col[order]],
                'hex': hexf(coo.data[order])}
    if v.dtype.names:
        d = {'class': 'struct', 'size': list(v.shape), 'fields': list(v.dtype.names)}
        if v.size == 1:
            d['values'] = {n: canon(v[n][0, 0]) for n in v.dtype.names}
        return d
    if v.dtype == object:
        return {'class': 'cell', 'size': list(v.shape),
                'items': [canon(x) for x in v.reshape(-1, order='F')]}
    if v.dtype.kind == 'U':
        units = []
        for j in range(v.shape[1]):
            for i in range(v.shape[0]):
                units.append(ord(str(v[i, j])))
        return {'class': 'char', 'size': list(v.shape), 'units': units}
    if v.dtype == np.bool_:
        return {'class': 'logical', 'size': list(v.shape), 'bits': [int(x) for x in v.reshape(-1, order='F')]}
    if v.dtype.kind in 'iu':
        return {'class': v.dtype.name, 'size': list(v.shape), 'dec': [str(int(x)) for x in v.reshape(-1, order='F')]}
    if v.dtype.kind == 'c':
        return {'class': 'double', 'size': list(v.shape), 'complex': True,
                'hex': hexf(v.real), 'imag_hex': hexf(v.imag)}
    return {'class': 'single' if v.dtype == np.float32 else 'double', 'size': list(v.shape),
            'complex': False, 'hex': hexf(v)}

def load(path):
    raw = sio.loadmat(path, chars_as_strings=False, struct_as_record=True, squeeze_me=False)
    return {k: canon(v) for k, v in raw.items() if not k.startswith('__')}

cases = {}
for name, compress in (('scipy_v5_plain.mat', False), ('scipy_v5_zlib.mat', True)):
    # The 10^6 x 10^6 sparse matrix (a 4 MB column-pointer array) lives only in the compressed file.
    sio.savemat(out / name, {**DATA, **({'sparse_big': big} if compress else {})}, do_compression=compress, oned_as='row')
    cases[name] = {'variables': load(out / name)}

# Hand-built big-endian Level-5 file (SciPy cannot write one but reads it, which verifies the builder).
def be_elem(dt, payload):
    pad = (-len(payload)) % 8
    return struct.pack('>II', dt, len(payload)) + payload + b'\0' * pad
def be_matrix(cls, name, dims, dt, body, flags=0):
    inner = be_elem(6, struct.pack('>II', cls | flags << 8, 0)) + be_elem(5, struct.pack('>%di' % len(dims), *dims))
    inner += be_elem(1, name.encode()) + be_elem(dt, body)
    return be_elem(14, inner)
head = b'MATLAB 5.0 MAT-file, big-endian fixture built by make_fixtures.py'.ljust(116) + b'\0' * 8 + struct.pack('>H', 0x0100) + b'MI'
be = head + be_matrix(6, 'dbl', [2, 2], 9, struct.pack('>4d', 1.5, -2.25, 0.1, 1e300))
be += be_matrix(10, 'i16', [1, 3], 3, struct.pack('>3h', -1, 2, 32767))
# SciPy misreads big-endian non-ASCII units, so tests/hostile.rs covers those by hand.
be += be_matrix(4, 'txt', [1, 3], 4, struct.pack('>3H', 0x41, 0x7e, 0x43))
be += be_matrix(14, 'big', [1, 2], 12, struct.pack('>2q', -2**63, 2**63 - 1))
(out / 'be_v5.mat').write_bytes(be)
cases['be_v5.mat'] = {'variables': load(out / 'be_v5.mat')}
assert cases['be_v5.mat']['variables']['big']['dec'] == [str(-2**63), str(2**63 - 1)]

# Typed refusals: Level 4 (SciPy) and v7.3 (h5py with the 512-byte MATLAB userblock).
sio.savemat(out / 'scipy_v4.mat', {'a': np.arange(6.).reshape(2, 3)}, format='4')
with h5py.File(out / 'h5py_v73.mat', 'w', userblock_size=512) as f:
    f['a'] = np.arange(6.).reshape(2, 3)
blk = b'MATLAB 7.3 MAT-file, h5py fixture'.ljust(116) + b'\0' * 8 + struct.pack('<H', 0x0200) + b'IM'
with open(out / 'h5py_v73.mat', 'r+b') as f:
    f.write(blk)
with h5py.File(out / 'h5py_v73.mat', 'r') as f:
    assert f['a'].shape == (2, 3)
cases['scipy_v4.mat'] = {'refusal': 'unsupported_version_v4'}
cases['h5py_v73.mat'] = {'refusal': 'unsupported_version_v73'}
(out / 'not_mat.bin').write_bytes(b'this is definitely not a MATLAB file, just text. ' * 4)
cases['not_mat.bin'] = {'refusal': 'not_mat'}

for name, c in cases.items():
    c['sha256'] = hashlib.sha256((out / name).read_bytes()).hexdigest()
cases['_generator'] = {'scipy': scipy.__version__, 'numpy': np.__version__, 'h5py': h5py.__version__}
(out / 'expected.json').write_text(json.dumps(cases, ensure_ascii=False, indent=1, allow_nan=False) + '\n')
print(f'Generated {len(cases) - 1} SciPy/h5py MAT fixtures.')
