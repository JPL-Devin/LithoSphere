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

        // Phase 2: Build color lookup
        const colorCache = new Map<
            number,
            { r: number; g: number; b: number }
        >()
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

        // Phase 3: Build per-segment Line2 meshes
        // Uses the same Line2/LineMaterial/LineGeometry approach as
        // vector.ts thickLine, with one Line2 per segment so each
        // segment gets its own solid color and mouse event support.
        for (const pts of allPaths) {
            // Convert all vertices to 3D positions
            const worldPositions: Vector3[] = []
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i]
                const v = this.p.p.projection.lonLatToVector3(
                    p.lng,
                    p.lat,
                    p.elev * this.p.p.options.exaggeration
                )
                worldPositions.push(new Vector3(v.x, v.y, v.z))
            }

            // Use firstPos centering to avoid floating-point jitter
            const firstPos = worldPositions[0].clone()

            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = worldPositions[i]
                const p1 = worldPositions[i + 1]

                // Segment positions relative to firstPos
                const positions = [
                    p0.x - firstPos.x,
                    p0.y - firstPos.y,
                    p0.z - firstPos.z,
                    p1.x - firstPos.x,
                    p1.y - firstPos.y,
                    p1.z - firstPos.z,
                ]

                // Average color of the two endpoints
                const rgb0 = colorForValue(pts[i].value)
                const rgb1 = colorForValue(pts[i + 1].value)
                const avgR = Math.round((rgb0.r + rgb1.r) / 2)
                const avgG = Math.round((rgb0.g + rgb1.g) / 2)
                const avgB = Math.round((rgb0.b + rgb1.b) / 2)
                const segColor = (avgR << 16) | (avgG << 8) | avgB

                const geometry = new LineGeometry()
                geometry.setPositions(positions)

                const material = new LineMaterial({
                    color: segColor,
                    linewidth: 0.0005 * weight,
                })

                const mesh = new Line2(geometry, material)
                mesh.computeLineDistances()
                mesh.position.set(
                    firstPos.x,
                    firstPos.y,
                    firstPos.z
                )
                mesh.scale.set(1, 1, 1)

                // Properties for the event system (mouse hover/click)
                // @ts-ignore
                mesh.layerName = layerObj.name
                // @ts-ignore
                mesh.strokeColor = segColor
                // @ts-ignore
                mesh.feature = {
                    type: 'Feature',
                    properties: Object.assign({}, pts[i].props, {
                        _gradientSegmentIndex: i,
                        _gradientValue: pts[i].value,
                        _gradientValueEnd: pts[i + 1].value,
                    }),
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [pts[i].lng, pts[i].lat, pts[i].elev],
                            [
                                pts[i + 1].lng,
                                pts[i + 1].lat,
                                pts[i + 1].elev,
                            ],
                        ],
                    },
                    _highlighted: false,
                    _active: false,
                }

                const defaultColor = segColor
                // @ts-ignore
                mesh.restyle = () => {
                    // @ts-ignore
                    const isHighlighted = mesh.feature._highlighted
                    // @ts-ignore
                    const isActive = mesh.feature._active
                    const c =
                        isHighlighted || isActive
                            ? 0xffffff
                            : defaultColor
                    mesh.material = new LineMaterial({
                        color: c,
                        linewidth:
                            0.0005 *
                            weight *
                            (isHighlighted || isActive ? 2 : 1),
                    })
                }

                gradientGroup.add(mesh)
            }
        }

        if (layerObj.on == false) {
            gradientGroup.visible = false
        }

        return gradientGroup
    }
}
