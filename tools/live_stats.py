# live_stats.py — точность живых решений LLM-ядра по журналу исходов (data/llm_outcomes.jsonl).
# Выводит общую точность, по парам и по часам UTC, с 95% интервалом и биномиальным p против 50%.
import json, sys, math, collections
from scipy.stats import binomtest
path=sys.argv[1] if len(sys.argv)>1 else 'data/llm_outcomes.jsonl'
rows=[json.loads(l) for l in open(path,encoding='utf-8') if l.strip()]
outs=[r for r in rows if r.get('type')=='outcome']
dec=[r for r in rows if r.get('type')=='decision']
print(f'решений записано: {len(dec)}, исходов: {len(outs)}')
def wilson(k,n,z=1.96):
    if n==0: return (float('nan'),float('nan'))
    p=k/n; d=1+z*z/n; c=(p+z*z/(2*n))/d; h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return (100*(c-h),100*(c+h))
def line(name,rs):
    n=len(rs); k=sum(1 for r in rs if r['correct'])
    if n==0: return
    lo,hi=wilson(k,n)
    print(f"  {name:14s} n={n:5d} точность {100*k/n:6.2f}% (95%: {lo:5.2f}–{hi:5.2f})  p={binomtest(k,n,0.5).pvalue:.3g}")
if outs:
    line('ВСЕГО',outs)
    bys=collections.defaultdict(list)
    for r in outs: bys[r.get('segment','?')].append(r)
    print('по сегментам:')
    for g,rs in sorted(bys.items()): line(g,rs)
    print('по парам:')
    for p,g in sorted(collections.defaultdict(list,{}).items()): pass
    byp=collections.defaultdict(list)
    for r in outs: byp[r['pair']].append(r)
    for p,g in sorted(byp.items()): line(p,g)
    print('по часам UTC:')
    byh=collections.defaultdict(list)
    for r in outs:
        h=__import__('datetime').datetime.utcfromtimestamp(r['candleTime']).hour
        byh[h].append(r)
    for h,g in sorted(byh.items()): line(f'{h:02d}:00',g)
