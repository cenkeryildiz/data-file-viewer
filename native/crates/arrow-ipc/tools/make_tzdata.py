"""Builds data/tzdata.bin from the OS zoneinfo: every IANA zone/link name -> its TZif v2+ block (64-bit data + POSIX footer),
deduplicated by content. Run: python tools/make_tzdata.py [zoneinfo-dir]  (default /var/db/timezone/zoneinfo)
Layout: "DFVTZ1\0\0" | u16 version-len | version | u32 nblobs | nblobs*(u32 off,u32 len) | u32 nnames | nnames*(u8 len,name,u32 blob) | blobs"""
import os,struct,sys
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else '/var/db/timezone/zoneinfo').resolve()
version=(root/'+VERSION').read_text().strip() if (root/'+VERSION').exists() else (root.parent/'..'/'..'/'tz_latest').resolve().name
skip={'posix','right'}
def v2_block(b):
    assert b[:4]==b'TZif'
    if b[4:5]<b'2':return None  # v1-only files carry 32-bit data; not used
    isut,isstd,leap,timecnt,typecnt,chars=struct.unpack('>6l',b[20:44])
    body=isut+isstd+leap*8+timecnt*5+typecnt*6+chars  # v1 data block length
    return b[44+body:]
blobs={};names={}
for dp,dn,fn in os.walk(root,followlinks=True):
    dn[:]=[d for d in dn if not(Path(dp)==root and d in skip)]
    for f in fn:
        p=Path(dp)/f;rel=p.relative_to(root).as_posix()
        if f.startswith('+') or rel in('posixrules','localtime','Factory'):continue
        b=p.read_bytes()
        if b[:4]!=b'TZif':continue
        blk=v2_block(b)
        if blk is None:raise SystemExit(f'{rel}: v1-only TZif')
        names[rel]=blobs.setdefault(blk,len(blobs))
order=list(blobs);out=bytearray(b'DFVTZ1\0\0')
out+=struct.pack('>H',len(version))+version.encode()+struct.pack('>I',len(order))
off=0
for blk in order:out+=struct.pack('>II',off,len(blk));off+=len(blk)
out+=struct.pack('>I',len(names))
for n in sorted(names):out+=bytes([len(n)])+n.encode()+struct.pack('>I',names[n])
for blk in order:out+=blk
Path(__file__).resolve().parent.parent.joinpath('data/tzdata.bin').write_bytes(out)
print(version,len(names),'names',len(order),'blobs',len(out),'bytes')
