#!/usr/bin/env python3
"""
Patch ELF object file: change HIDDEN visibility to DEFAULT for curl_* symbols only.

curl-impersonate v1.4.0+ only ships static .a archives with HIDDEN symbol visibility.
The impers (Node.js FFI) library needs a shared .so with exported curl_* symbols.
This script patches the ELF symbol table to make ONLY curl_* symbols globally visible,
keeping internal symbols (Curl_*, ngtcp2_*, etc.) hidden to avoid relocation errors.

Usage:
    python3 patch-elf-visibility.py <input.o> <output.o>
"""

import struct
import sys
import os


def patch_elf_visibility(input_path: str, output_path: str) -> int:
    """
    Patch HIDDEN (STV_HIDDEN=2) symbols to DEFAULT (STV_DEFAULT=0)
    ONLY for symbols whose name starts with 'curl_' (the public libcurl API).
    
    Internal symbols (Curl_*, ngtcp2_*, etc.) are kept HIDDEN to avoid
    R_X86_64_PC32 relocation errors when linking into a shared library.
    
    Returns the number of symbols patched.
    """
    with open(input_path, "rb") as f:
        data = bytearray(f.read())

    # Verify ELF magic
    if data[:4] != b"\x7fELF":
        raise ValueError(f"Not an ELF file: {input_path}")

    # ELF64 header parsing
    ei_class = data[4]
    if ei_class != 2:
        raise ValueError("Only ELF64 is supported")

    ei_data = data[5]  # 1=LE, 2=BE
    if ei_data != 1:
        raise ValueError("Only little-endian ELF is supported")

    # Parse ELF64 header
    e_shoff = struct.unpack_from("<Q", data, 40)[0]     # Section header table offset
    e_shentsize = struct.unpack_from("<H", data, 58)[0]  # Section header entry size
    e_shnum = struct.unpack_from("<H", data, 60)[0]      # Number of section headers

    patched_count = 0

    # Find .symtab sections
    for i in range(e_shnum):
        sh_offset_pos = e_shoff + i * e_shentsize
        sh_type = struct.unpack_from("<I", data, sh_offset_pos + 4)[0]

        # SHT_SYMTAB = 2
        if sh_type != 2:
            continue

        sym_offset = struct.unpack_from("<Q", data, sh_offset_pos + 24)[0]
        sym_size = struct.unpack_from("<Q", data, sh_offset_pos + 32)[0]
        sym_entsize = struct.unpack_from("<Q", data, sh_offset_pos + 56)[0]
        sh_link = struct.unpack_from("<I", data, sh_offset_pos + 40)[0]

        if sym_entsize == 0:
            continue

        # Get the associated string table
        strtab_sh_pos = e_shoff + sh_link * e_shentsize
        strtab_offset = struct.unpack_from("<Q", data, strtab_sh_pos + 24)[0]
        strtab_size = struct.unpack_from("<Q", data, strtab_sh_pos + 32)[0]

        num_symbols = sym_size // sym_entsize

        for j in range(num_symbols):
            sym_pos = sym_offset + j * sym_entsize
            # ELF64 Sym: st_name(4) st_info(1) st_other(1) st_shndx(2) st_value(8) st_size(8)
            st_name_idx = struct.unpack_from("<I", data, sym_pos)[0]
            st_other = data[sym_pos + 5]
            visibility = st_other & 0x03

            # Only patch HIDDEN symbols
            if visibility != 2:
                continue

            # Get symbol name from string table
            name_start = strtab_offset + st_name_idx
            if name_start >= strtab_offset + strtab_size:
                continue

            # Find null terminator
            name_end = name_start
            while name_end < len(data) and data[name_end] != 0:
                name_end += 1
            name = data[name_start:name_end].decode("ascii", errors="replace")

            # ONLY patch curl_* symbols (lowercase = public API)
            # Skip Curl_* (internal), ngtcp2_*, nghttp2_*, etc.
            if name.startswith("curl_"):
                data[sym_pos + 5] = st_other & ~0x03  # Clear visibility bits (DEFAULT=0)
                patched_count += 1

    with open(output_path, "wb") as f:
        f.write(data)

    return patched_count


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.o> <output.o>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    if not os.path.exists(input_file):
        print(f"Error: {input_file} not found", file=sys.stderr)
        sys.exit(1)

    count = patch_elf_visibility(input_file, output_file)
    print(f"Patched {count} curl_* symbols from HIDDEN to DEFAULT in {output_file}")
