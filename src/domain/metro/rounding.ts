/**
 * Python-compatible rounding (exact, via BigInt).
 *
 * Python's round() is round-half-to-even on the binary float ("bankers rounding"), while JS
 * Math.round is round-half-up. Golden parity with the FastAPI backend needs the same doubles in
 * every payload (route distances, journey minutes, walk times), so every rounding the backend
 * did with round() goes through this helper.
 *
 * Exactness: the IEEE 754 double is decomposed into mantissa * 2^exponent; value * 10^digits is
 * formed as an exact rational (numerator/denominator in BigInts), the nearest multiple is chosen
 * with ties going to the even multiple, and the exact result is divided once in IEEE arithmetic —
 * byte-for-byte what CPython's _Py_dg_double_rounding produces, without heuristics.
 */
export function pyRound(value: number, digits: number = 0): number {
  if (!Number.isFinite(value)) return value
  if (value === 0) return value

  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const bits = view.getBigUint64(0)
  const negative = (bits >> 63n) & 1n ? true : false
  const biasedExponent = Number((bits >> 52n) & ((1n << 11n) - 1n))
  const mantissaBits = bits & ((1n << 52n) - 1n)

  let mantissa: bigint
  let exponent: number
  if (biasedExponent === 0) {
    if (mantissaBits === 0n) return value // +-0
    mantissa = mantissaBits // subnormal
    exponent = -1074
  } else {
    mantissa = mantissaBits | (1n << 52n) // implicit leading 1
    exponent = biasedExponent - 1075
  }
  // value = (+-) mantissa * 2^exponent

  const scale = BigInt(digits)
  // value * 10^digits = (+-) mantissa * 5^digits * 2^(exponent + digits)
  const shift = exponent + digits
  const fivePow = 5n ** scale
  const mantissaByFive = mantissa * fivePow

  let unit: bigint // the exact integer part of value*10^digits (before tie/round handling)
  if (shift >= 0) {
    unit = mantissaByFive << BigInt(shift) // already an integer multiple: no rounding happens
  } else {
    const denominator = 1n << BigInt(-shift) // 2^-shift
    const remainder = mantissaByFive & (denominator - 1n)
    unit = mantissaByFive >> BigInt(-shift) // Math.floor for positives and negatives alike (sign applied later)
    const half = denominator >> 1n
    if (remainder === half) {
      unit = unit % 2n === 0n ? unit : unit + 1n // exact tie: round to even
    } else if (remainder > half) {
      unit = unit + 1n
    }
  }
  // result = unit / 10^digits, by IEEE division (one final correctly-rounded step, as in Python)
  const roundedUnit = negative ? -unit : unit
  return Number(roundedUnit) / 10 ** digits
}

/** int(round(x)) — backend.py often does int(round(...)) on hours/minutes (always >= 0 there). */
export function pyRoundInt(value: number): number {
  return Math.trunc(pyRound(value))
}

/**
 * Neumaier compensated summation — what Python 3.12+'s builtin sum() uses for floats (CPython
 * switched from naive left-to-right addition). Golden parity needs the same compensated
 * accumulation wherever backend code wrote sum() over a numeric generator, e.g. journey ride
 * minutes; the bare += loops (describe()'s running km) stay naive on both sides.
 */
export function pySum(values: number[]): number {
  let sum = 0
  let compensation = 0
  for (const x of values) {
    const t = sum + x
    if (Math.abs(sum) >= Math.abs(x)) compensation += sum - t + x
    else compensation += x - t + sum
    sum = t
  }
  return sum + compensation
}
