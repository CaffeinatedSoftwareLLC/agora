#!/usr/bin/env python3
"""Check docs/planning/beta-test-surfaces.csv against the beta test plan.

    python docs/planning/check-coverage-ledger.py

Fails (exit 1) when a row is unmapped, has an unknown coverage_state, lacks
scenario IDs where they are required, uses a malformed scenario ID, or uses a
suffixed ID that appears in none of: beta-test-plan.md, beta-test-coverage-review.md,
or an e2e spec title (e2e/tests/*.spec.ts, `[ID]` in the title).
Prints counts by kind x coverage_state and the scenario IDs no row references.
"""
import csv
import glob
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
LEDGER = os.path.join(HERE, 'beta-test-surfaces.csv')
PLAN = os.path.join(HERE, 'beta-test-plan.md')
REVIEW = os.path.join(HERE, 'beta-test-coverage-review.md')
SPECS = os.path.join(ROOT, 'e2e', 'tests', '*.spec.ts')

HEADER = ['surface_id', 'kind', 'source', 'line', 'entrypoint', 'scenario_ids', 'coverage_state', 'baseline_sha']
ID_RE = re.compile(r'^(ID|UI|AG|OP|SEC)-\d{2}(\.[a-z0-9-]+)?$')
FIND_RE = re.compile(r'\b(?:ID|UI|AG|OP|SEC)-\d{2}(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)?')
TITLE_RE = re.compile(r"""\btest(?:\.\w+)?\(\s*['"`]\[((?:ID|UI|AG|OP|SEC)-\d{2}(?:\.[a-z0-9-]+)?)\]""")
STATES = {'mapped', 'anchor', 'gap'}


def known_ids():
    doc_ids = set()
    for path in (PLAN, REVIEW):
        with open(path, encoding='utf-8') as fh:
            # Drop wildcard suffixes (`AG-04.siwc-*`) so they don't read as an ID `AG-04.siwc`
            text = re.sub(r'\.[a-z0-9-]*\*', '', fh.read())
            doc_ids.update(FIND_RE.findall(text))
    spec_ids = set()
    for path in glob.glob(SPECS):
        with open(path, encoding='utf-8') as fh:
            spec_ids.update(TITLE_RE.findall(fh.read()))
    return doc_ids, spec_ids


def main():
    doc_ids, spec_ids = known_ids()
    known = doc_ids | spec_ids
    families = {i for i in known if '.' not in i}
    errors = []

    with open(LEDGER, encoding='utf-8', newline='') as fh:
        reader = csv.reader(fh)
        header = next(reader)
        rows = list(reader)
    if header != HEADER:
        errors.append(f'header is {header}, expected {HEADER}')

    seen = set()
    counts = Counter()
    used = set()
    for n, raw in enumerate(rows, start=2):
        if len(raw) != len(HEADER):
            errors.append(f'line {n}: {len(raw)} columns'); continue
        r = dict(zip(HEADER, raw))
        sid, kind, state = r['surface_id'], r['kind'], r['coverage_state']
        where = f'line {n} ({sid})'
        if not re.fullmatch(r'S\d{4}', sid):
            errors.append(f'{where}: bad surface_id')
        if sid in seen:
            errors.append(f'{where}: duplicate surface_id')
        seen.add(sid)
        if not r['baseline_sha'] or not re.fullmatch(r'[0-9a-f]{40}', r['baseline_sha']):
            errors.append(f'{where}: baseline_sha missing or not a full SHA')

        if not state:
            errors.append(f'{where}: empty coverage_state')
        elif state == 'unmapped':
            errors.append(f'{where}: still unmapped')
        elif state.startswith('excluded:'):
            if len(state) <= len('excluded:') + 3:
                errors.append(f'{where}: exclusion needs a reason')
        elif state not in STATES:
            errors.append(f'{where}: unknown coverage_state {state!r}')
        if state == 'anchor' and kind != 'test_anchor':
            errors.append(f'{where}: anchor state on a {kind} row')
        if kind == 'test_anchor' and state in ('mapped', 'gap'):
            errors.append(f'{where}: test_anchor rows are anchor or excluded, not {state}')

        ids = [i for i in r['scenario_ids'].split(';') if i] if r['scenario_ids'] else []
        if state in STATES and not ids:
            errors.append(f'{where}: {state} row without scenario_ids')
        if len(ids) != len(set(ids)):
            errors.append(f'{where}: repeated scenario ID')
        for i in ids:
            if not ID_RE.match(i):
                errors.append(f'{where}: malformed scenario ID {i!r}')
            elif '.' in i and i not in known:
                errors.append(f'{where}: suffixed ID {i!r} not in plan, coverage review or an e2e spec title')
            elif '.' not in i and i not in families:
                errors.append(f'{where}: family {i!r} not defined in the plan or coverage review')
            used.add(i)
        counts[(kind, state.split(':')[0])] += 1

    kinds = sorted({k for k, _ in counts})
    cols = ['mapped', 'anchor', 'gap', 'excluded']
    print(f'{len(rows)} rows')
    print('kind'.ljust(18) + ''.join(c.rjust(10) for c in cols) + 'total'.rjust(8))
    for k in kinds:
        line = [counts[(k, c)] for c in cols]
        print(k.ljust(18) + ''.join(str(v).rjust(10) for v in line) + str(sum(line)).rjust(8))
    tot = [sum(counts[(k, c)] for k in kinds) for c in cols]
    print('total'.ljust(18) + ''.join(str(v).rjust(10) for v in tot) + str(sum(tot)).rjust(8))

    unused = sorted(i for i in known if ID_RE.match(i) and i not in used)
    print('\nscenario IDs referenced by plan/review/specs but mapped to no surface:')
    print('  ' + (', '.join(unused) if unused else '(none)'))

    if errors:
        print(f'\nFAIL: {len(errors)} problem(s)')
        for e in errors:
            print('  ' + e)
        return 1
    print('\nOK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
