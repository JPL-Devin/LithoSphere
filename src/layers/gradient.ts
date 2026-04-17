import { Object3D, Vector3 } from 'three'
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial'
import { Line2 } from 'three/examples/jsm/lines/Line2'

import Utils from '../utils'
import {
    buildColorStops,
    interpolateMultipleColors,
    parseRgb,
    hexToRgb,
} from '../utils/gradientUtils'
import {
    coordinateDepthTraversal,
    getCoordProperties,
} from '../utils/coordProperties'

interface GradientVertex {
    lng: number
    lat: number
    elev: number
    value: number
    props: Record<string, any>
}

export default class GradientLayerer {
    // parent
    p: any

    constructor(parent: any) {
        this.p = parent
    }

    add = (layerObj: any, callback?: Function): void => {
        if (!this.p.p._.wasInitialized) return

        let alreadyExists = false

        const finallyAdd = () => {
            for (let i = 0; i < this.p.gradient.length; i++) {
                if (this.p.gradient[i].hasOwnProperty('name')) {
                    if (this.p.gradient[i].name == layerObj.name) {
                        this.p.gradient[i] = layerObj
                        alreadyExists = true
                        break
                    }
                }
            }
            if (!alreadyExists) {
                const meshes = this.generateGradientLines(layerObj)
                if (meshes) {
                    this.p.p.planet.add(meshes)
                    layerObj.meshes = meshes
                    this.p.gradient.push(layerObj)
                    this.p.gradient.sort(
                        (a: any, b: any) => b.order - a.order
                    )
                }
            }
            this.p.p._.events._attenuate()
            if (typeof callback === 'function') callback()
        }

        if (
            layerObj.hasOwnProperty('name') &&
            layerObj.hasOwnProperty('on') &&
            layerObj.hasOwnProperty('opacity') &&
            layerObj.hasOwnProperty('gradientSettings')
        ) {
            if (
                layerObj.hasOwnProperty('geojsonPath') &&
                !layerObj.hasOwnProperty('geojson')
            ) {
                const xhr = new XMLHttpRequest()
                xhr.open('GET', layerObj.geojsonPath, true)
                xhr.responseType = 'json'
                xhr.withCredentials =
                    layerObj.withCredentials === true || false
                xhr.onload = () => {
                    if (xhr.status !== 404 && xhr.response) {
                        layerObj.geojson = xhr.response
                        finallyAdd()
                    } else {
                        console.warn(
                            `Failed to fetch geojson data for gradient layer: ${layerObj.name}`
                        )
                    }
                }
                xhr.send()
            } else {
                finallyAdd()
            }
        } else {
            console.warn(
                `Attempted to add an invalid gradient layer: ${layerObj.name}`
            )
        }
    }

    toggle = (name: string, on?: boolean): boolean => {
        if (!this.p.p._.wasInitialized) return false

        for (let i = 0; i < this.p.gradient.length; i++) {
            const layer = this.p.gradient[i]
            if (name === layer.name) {
                layer.on = on != null ? on : !layer.on
                layer.meshes.visible = layer.on
                this.p.p._.events._attenuate()
                return true
            }
        }
        return false
    }

    setOpacity = (name: string, opacity: number): boolean => {
        if (!this.p.p._.wasInitialized) return false

        for (let i = 0; i < this.p.gradient.length; i++) {
            const layer = this.p.gradient[i]
            if (name === layer.name) {
                layer.opacity = Math.max(Math.min(opacity, 1), 0)
                layer.meshes.children.forEach((mesh: any) => {
                    mesh.material.opacity = layer.opacity
                    mesh.material.transparent = true
                })
                return true
            }
        }
        return false
    }

    remove = (name: string): boolean => {
        if (!this.p.p._.wasInitialized) return false

        for (let i = 0; i < this.p.gradient.length; i++) {
            if (this.p.gradient[i].name === name) {
                this.p.p.planet.remove(this.p.gradient[i].meshes)
                this.p.gradient.splice(i, 1)
                return true
            }
        }
        return false
    }

    private generateGradientLines = (layerObj: any): Object3D | undefined => {
        const gradientGroup = new Object3D()

        if (layerObj.geojson == null) {
            console.warn(
                `Gradient layer: ${layerObj.name} has no geojson.`
            )
            return
        }
        const features = layerObj.geojson.features
        if (features == null) {
            console.warn(
                `Gradient layer: ${layerObj.name} has invalid geojson.`
            )
            return
        }

        const gradientSettings = layerObj.gradientSettings
        const colorWithProp = gradientSettings.colorWithProp
        const colorStops = buildColorStops(gradientSettings.colorRamp)
        const weight = gradientSettings.weight || 4

        // Phase 1: Collect all vertices with property values
        const allPaths: GradientVertex[][] = []
        let min = Infinity
        let max = -Infinity

        let i0 = 0
        let i1 = 1
        if (layerObj.swapLL) {
            i0 = 1
            i1 = 0
        }

        if (gradientSettings.connectAllPoints) {
            const points: GradientVertex[] = []
            for (let fi = 0; fi < features.length; fi++) {
                const feature = features[fi]
                if (
                    feature.geometry.type.toLowerCase() === 'point'
                ) {
                    const coords = feature.geometry.coordinates
                    const value = Utils.getIn(
                        feature.properties,
                        colorWithProp,
                        0
                    )
                    if (min > value) min = value
                    if (max < value) max = value
                    points.push({
                        lng: coords[i0],
                        lat: coords[i1],
                        elev: coords[2] || 0,
                        value,
                        props: feature.properties,
                    })
                }
            }
            if (points.length >= 2) allPaths.push(points)
        } else {
            for (let fi = 0; fi < features.length; fi++) {
                const feature = features[fi]
                const paths: GradientVertex[][] = []
                let path: GradientVertex[] = []
                let prevParentIndex: string | null = null

                coordinateDepthTraversal(
                    feature.geometry.coordinates,
                    (array: any[], _path: string) => {
                        const splitPath = _path.split('.')
                        let parentIndex: string | null = null
                        if (splitPath.length >= 2) {
                            parentIndex =
                                splitPath[splitPath.length - 2]
                            if (
                                prevParentIndex != null &&
                                parentIndex != prevParentIndex
                            ) {
                                paths.push(path)
                                path = []
                            }
                        }
                        const props = getCoordProperties(
                            layerObj.geojson,
                            feature,
                            array
                        )
                        const value = Utils.getIn(
                            props,
                            colorWithProp,
                            0
                        )
                        if (min > value) min = value
                        if (max < value) max = value
                        path.push({
                            lng: array[i0],
                            lat: array[i1],
                            elev: array[2] || 0,
                            value,
                            props,
                        })
                        prevParentIndex = parentIndex
                    }
                )
                if (path.length > 0) paths.push(path)
                paths.forEach((p) => {
                    if (p.length >= 2) allPaths.push(p)
                })
            }
        }

        if (min === 0 && max === 0) max = 1

        // Phase 2: Build Three.js geometry with per-vertex colors
        const colorCache = new Map<number, { r: number; g: number; b: number }>()
        const colorForValue = (
            v: number
        ): { r: number; g: number; b: number } => {
            if (colorCache.has(v)) return colorCache.get(v)!
            const c = interpolateMultipleColors(colorStops, v, min, max)
            let rgb = { r: 255, g: 255, b: 255 }
            if (c) {
                const parsed = parseRgb(c) || hexToRgb(c)
                if (parsed) rgb = parsed
            }
            colorCache.set(v, rgb)
            return rgb
        }

        const hoverSegments: any[] = []

        for (const pts of allPaths) {
            const positions: number[] = []
            const colors: number[] = []
            let firstPos: Vector3 | null = null

            for (let i = 0; i < pts.length; i++) {
                const p = pts[i]
                const v = this.p.p.projection.lonLatToVector3(
                    p.lng,
                    p.lat,
                    p.elev * this.p.p.options.exaggeration
                )

                if (i === 0) {
                    firstPos = new Vector3(v.x, v.y, v.z)
                }

                positions.push(
                    v.x - firstPos!.x,
                    v.y - firstPos!.y,
                    v.z - firstPos!.z
                )

                const rgb = colorForValue(p.value)
                colors.push(rgb.r / 255, rgb.g / 255, rgb.b / 255)
            }

            if (positions.length >= 6 && firstPos) {
                const geometry = new LineGeometry()
                geometry.setPositions(positions)
                geometry.setColors(colors)

                const container = this.p.p._.container
                const material = new LineMaterial({
                    linewidth: 0.0005 * weight,
                    vertexColors: true,
                    transparent: true,
                    depthTest: false,
                    opacity:
                        layerObj.opacity != null ? layerObj.opacity : 1,
                })
                material.resolution.set(
                    container.clientWidth || window.innerWidth,
                    container.clientHeight || window.innerHeight
                )

                const mesh = new Line2(geometry, material)
                mesh.computeLineDistances()
                mesh.position.set(
                    firstPos.x,
                    firstPos.y,
                    firstPos.z
                )
                mesh.scale.set(1, 1, 1)

                gradientGroup.add(mesh)
            }

            // Build hover segment data
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i]
                const p2 = pts[i + 1]
                hoverSegments.push({
                    lng1: p1.lng,
                    lat1: p1.lat,
                    elev1: p1.elev || 0,
                    lng2: p2.lng,
                    lat2: p2.lat,
                    elev2: p2.elev || 0,
                })
            }
        }

        // Build spatial grid for hover
        const gridRes = 0.01
        const segmentGrid: Record<string, number[]> = {}
        for (let idx = 0; idx < hoverSegments.length; idx++) {
            const seg = hoverSegments[idx]
            const gx1 = Math.floor(seg.lng1 / gridRes)
            const gy1 = Math.floor(seg.lat1 / gridRes)
            const gx2 = Math.floor(seg.lng2 / gridRes)
            const gy2 = Math.floor(seg.lat2 / gridRes)
            const span = Math.max(
                Math.abs(gx2 - gx1),
                Math.abs(gy2 - gy1)
            )
            const steps = Math.min(12, Math.max(1, Math.ceil(span / 2)))
            const seenCells = new Set<string>()
            for (let s = 0; s <= steps; s++) {
                const t = s / steps
                const gx = Math.floor(
                    (seg.lng1 + t * (seg.lng2 - seg.lng1)) / gridRes
                )
                const gy = Math.floor(
                    (seg.lat1 + t * (seg.lat2 - seg.lat1)) / gridRes
                )
                const key = `${gx},${gy}`
                if (seenCells.has(key)) continue
                seenCells.add(key)
                if (!segmentGrid[key]) segmentGrid[key] = []
                segmentGrid[key].push(idx)
            }
        }

        layerObj.hoverSegments = hoverSegments
        layerObj.segmentGrid = segmentGrid
        layerObj.gridRes = gridRes

        if (layerObj.on == false) {
            gradientGroup.visible = false
        }

        return gradientGroup
    }
}
