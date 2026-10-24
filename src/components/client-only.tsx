"use client"

import dynamic from "next/dynamic"

// The Leaflet pages touch `window` as soon as they load, so they render in the browser only.
export const RoutesInfo = dynamic(() => import("./RoutesInfo"), { ssr: false })
export const NearestStations = dynamic(() => import("./NearestStations"), { ssr: false })
