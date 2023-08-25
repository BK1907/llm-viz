import { getOrAddToMap, hasFlag, isNotNil } from "../utils/data";
import { CompLibrary, IResetOptions } from "./comps/CompBuilder";
import { PortDir, ICpuLayout, IExeComp, IExeNet, IExePortRef, IExeSystem, RefType, IExeStep, IExeSystemLookup, IElRef, IoDir } from "./CpuModel";

export function createExecutionModel(compLibrary: CompLibrary, displayModel: ICpuLayout, existingSystem: IExeSystem | null): IExeSystem {

    let connectedCompIds = new Set<string>();
    let connectedNetIds = new Set<string>();

    for (let wire of displayModel.wires) {
        let hasRef = false;
        for (let node of wire.nodes) {
            if (node.ref?.type === RefType.CompNode) {
                connectedCompIds.add(node.ref.id);
                hasRef = true;
            }
        }
        if (hasRef) {
            connectedNetIds.add(wire.id);
        }
    }
    let connectedComps = displayModel.comps.filter(c => connectedCompIds.has(c.id));
    let connectedWires = displayModel.wires.filter(w => connectedNetIds.has(w.id));

    let compIdToIdx = new Map<string, number>();
    for (let i = 0; i < connectedComps.length; i++) {
        compIdToIdx.set(connectedComps[i].id, i);
    }

    let comps: IExeComp[] = [];

    let nets: IExeNet[] = [];

    for (let wire of connectedWires) {
        let refs = wire.nodes.map(n => n.ref).filter(isNotNil);

        let inputs: IExePortRef[] = [];
        let outputs: IExePortRef[] = [];
        for (let ref of refs) {
            const comp = connectedComps[compIdToIdx.get(ref.id)!];
            if (!comp) {
                continue;
            }
            for (let nodeIdx = 0; nodeIdx < comp.ports.length; nodeIdx++) {
                const node = comp.ports[nodeIdx];
                if (node.id === ref.compNodeId) {
                    if (hasFlag(node.type, PortDir.In)) {
                        inputs.push({ compIdx: compIdToIdx.get(comp.id)!, portIdx: nodeIdx, exePort: null!, valid: false });
                    }
                    if (hasFlag(node.type, PortDir.Out)) {
                        outputs.push({ compIdx: compIdToIdx.get(comp.id)!, portIdx: nodeIdx, exePort: null!, valid: false });
                    }
                    break;
                }
            }
        }

        let net: IExeNet = {
            width: 1,
            wire,
            tristate: false,
            inputs: inputs,
            outputs: outputs,
            value: 0,
            enabledCount: 0,
            type: 0,
        };

        nets.push(net);
    }

    for (let comp of connectedComps) {
        let createdComp = compLibrary.build(comp);

        if (existingSystem) {
            let existingComp = existingSystem.comps[existingSystem.lookup.compIdToIdx.get(comp.id)!];
            if (existingComp) {
                // @TODO: while this keeps the data around, it doesn't update other things
                // that might get modified in code with hot-reloading
                // Maybe want per-comp custom logic to copy stateful data around? (mem;regs)
                let def = compLibrary.comps.get(comp.defId)!;
                if (def.copyStatefulData) {
                    def.copyStatefulData(existingComp.data, createdComp.data);
                }
            }
        }

        comps.push(createdComp);
    }

    for (let netIdx = 0; netIdx < nets.length; netIdx++) {
        let net = nets[netIdx];
        for (let portRef of [...net.inputs, ...net.outputs]) {
            let comp = comps[portRef.compIdx];
            let port = comp.ports[portRef.portIdx];
            port.netIdx = netIdx;
            if (hasFlag(port.type, PortDir.Tristate)) {
                net.tristate = true;
            }
            net.width = port.width;
            net.type |= port.type;
            portRef.exePort = port;
            portRef.valid = comp.valid;
        }
    }

    let compExecutionOrder = calcCompExecutionOrder(comps, nets);

    return { comps, nets, ...compExecutionOrder, lookup: createLookupTable(comps, nets), runArgs: { halt: false }, compLibrary };
}

export function createLookupTable(comps: IExeComp[], nets: IExeNet[]): IExeSystemLookup {
    let compIdToIdx = new Map<string, number>();
    for (let i = 0; i < comps.length; i++) {
        compIdToIdx.set(comps[i].comp.id, i);
    }

    let wireIdToNetIdx = new Map<string, number>();
    for (let i = 0; i < nets.length; i++) {
        wireIdToNetIdx.set(nets[i].wire.id, i);
    }

    return { compIdToIdx, wireIdToNetIdx };
}

export function lookupPortInfo(system: IExeSystem, ref: IElRef) {
    let compIdx = system.lookup.compIdToIdx.get(ref.id) ?? -1;
    let compExe = system.comps[compIdx];
    if (!compExe) {
        return null;
    }
    let portIdx = compExe.comp.ports.findIndex(p => p.id === ref.compNodeId);
    if (portIdx < 0) {
        return null;
    }
    let portExe = compExe.ports[portIdx];
    let comp = compExe.comp;
    let port = comp.ports[portIdx];
    return { compIdx, portIdx, compExe, portExe, comp, port };
}

export function calcCompExecutionOrder(comps: IExeComp[], nets: IExeNet[]): { executionSteps: IExeStep[], latchSteps: IExeStep[] } {

    // tristate nets can only propagate once all comps have completed, so consider them as nodes
    // in the graph as well (do this with all nets for simplicity)
    let numComps = comps.length + nets.length;

    let inDegree = new Map<number, number>();

    let compPhaseToNodeId = (compIdx: number, phaseIdx: number) => {
        return compIdx + phaseIdx * numComps;
    };

    let netToNodeId = (netIdx: number) => {
        return comps.length + netIdx;
    };

    let nodeIdToCompPhaseIdx = (nodeId: number) => {
        if (nodeId >= comps.length && nodeId < numComps) {
            return null; // net
        }

        return {
            compIdx: nodeId % numComps,
            phaseIdx: Math.floor(nodeId / numComps),
        };
    };

    let nodeIdToNetIdx = (nodeId: number) => {
        if (nodeId < comps.length || nodeId >= numComps) {
            return null; // comp
        }
        return nodeId - comps.length;
    }

    let topoNodeOrder: number[] = [];
    let edges = new Map<number, number[]>();
    let numExeNodes = 0;

    for (let cId = 0; cId < comps.length; cId++) {
        let comp = comps[cId];
        for (let pIdx = 0; pIdx < comp.phases.length; pIdx++) {
            let phase = comp.phases[pIdx];
            let nodeId = compPhaseToNodeId(cId, pIdx);
            // let afterPrevPhase = pIdx > 0;
            let hasNextPhase = pIdx < comp.phases.length - 1;

            // let linkedReadPortCount = phase.readPortIdxs.filter(i => comp.ports[i].netIdx >= 0).length;

            inDegree.set(nodeId, 0);
            let nodeEdges = getOrAddToMap(edges, nodeId, () => []);
            if (hasNextPhase) {
                let nextNodeId = compPhaseToNodeId(cId, pIdx + 1);
                nodeEdges.push(nextNodeId);
            }
            numExeNodes += 1;
            for (let portIdx of phase.writePortIdxs) {
                let port = comp.ports[portIdx];
                let net = nets[port.netIdx];
                if (!net) {
                    continue;
                }
                let netNodeId = netToNodeId(port.netIdx);
                nodeEdges.push(netNodeId);
            }
        }
    }

    for (let nId = 0; nId < nets.length; nId++) {
        let net = nets[nId];
        let netNodeId = netToNodeId(nId);
        inDegree.set(netNodeId, 0);
        let nodeEdges = getOrAddToMap(edges, netNodeId, () => []);

        for (let input of net.inputs) {
            let destComp = comps[input.compIdx];
            let destPhaseIdx = destComp.phases.findIndex(p => p.readPortIdxs.includes(input.portIdx));
            if (destPhaseIdx >= 0) {
                let outputNodeId = compPhaseToNodeId(input.compIdx, destPhaseIdx);
                nodeEdges.push(outputNodeId);
            }
        }

    }

    for (let [, destIds] of edges) {
        for (let destId of destIds) {
            let deg = inDegree.get(destId) ?? 0;
            inDegree.set(destId, deg + 1);
        }
    }

    // console.log('inDegreeOriginal:', new Map(inDegree));

    let queue: number[] = [];
    for (let [nodeId, degree] of inDegree) {
        if (degree === 0) {
            queue.push(nodeId);
        }
    }

    while (queue.length > 0) {
        let nodeId = queue.splice(0, 1)[0];
        topoNodeOrder.push(nodeId);
        let nodeEdges = edges.get(nodeId);
        if (nodeEdges) {
            for (let destNodeId of nodeEdges) {
                let degree = inDegree.get(destNodeId)!;
                degree--;
                inDegree.set(destNodeId, degree);
                if (degree === 0) {
                    queue.push(destNodeId);
                }
            }
        }
    }

    let numPhasesRun: number[] = comps.map(_ => 0);

    let executionSteps: IExeStep[] = [];
    let latchSteps: IExeStep[] = [];
    // console.log('--- topoNodeOrder ---');
    // console.log('comps:', comps.map((c, i) => `${compPhaseToNodeId(i, 0)}: ${c.comp.name}`).join(', '));
    // console.log('nets:', nets.map((n, i) => `${netToNodeId(i)}: ${netToString(n, comps)}`).join(', '));
    // console.log('inDegree:', new Map(inDegree));
    // console.log('edges:', edges);

    for (let nodeId of topoNodeOrder) {
        let compPhase = nodeIdToCompPhaseIdx(nodeId);
        if (compPhase) {
            // console.log('found comp', nodeId, 'compPhase', compPhase, 'comp', comps[compPhase.compIdx].comp.name, `(${compPhase.phaseIdx+1}/${comps[compPhase.compIdx].phases.length})`);
            let { compIdx, phaseIdx } = compPhase;
            if (phaseIdx !== numPhasesRun[compIdx]) {
                console.log('detected an incorrectly ordered phase; execution order may be incorrect');
            }
            numPhasesRun[compIdx] = phaseIdx + 1;

            let comp = comps[compIdx];
            let phase = comp.phases[phaseIdx];
            let step: IExeStep = {
                compIdx,
                phaseIdx,
                netIdx: -1,
            };
            if (phase.isLatch) {
                latchSteps.push(step);
            } else {
                executionSteps.push(step);
            }
        } else {
            let netIdx = nodeIdToNetIdx(nodeId)!;
            // console.log('found net', nodeId, netToString(nets[netIdx], comps));

            let step: IExeStep = {
                compIdx: -1,
                phaseIdx: -1,
                netIdx,
            };
            executionSteps.push(step);
        }

    }

    let phaseStepCount = [...executionSteps, ...latchSteps].filter(a => a.compIdx >= 0).length;

    if (phaseStepCount !== numExeNodes) {
        console.log('detected a cycle; execution order may be incorrect: expected exe nodes', numExeNodes, 'got', phaseStepCount);
        console.log(comps, nets);
    } else {
        // console.log('execution order:');
    }

    // let compsToExecute = compExecutionOrder.map(i => comps[i].comp.name);
    // console.log('compsToExecute', compsToExecute);

    return { executionSteps, latchSteps };
}

export function stepExecutionCombinatorial(exeModel: IExeSystem, disableBackProp = false) {
    let exeSteps = exeModel.executionSteps;
    exeModel.runArgs.halt = false;

    for (let i = 0; i < exeSteps.length; i++) {
        let step = exeSteps[i];
        if (step.compIdx >= 0) {
            let comp = exeModel.comps[step.compIdx];
            // console.log(`running comp ${comp.comp.name} phase ${step.phaseIdx}`);
            comp.phases[step.phaseIdx].func(comp, exeModel.runArgs);
        } else {
            let net = exeModel.nets[step.netIdx];
            runNet(exeModel.comps, net);
        }
    }

    if (!disableBackProp) {
        backpropagateUnusedSignals(exeModel);
    }
}

export function stepExecutionLatch(exeModel: IExeSystem) {
    let latchSteps = exeModel.latchSteps;
    for (let i = 0; i < latchSteps.length; i++) {
        let step = latchSteps[i];
        let comp = exeModel.comps[step.compIdx];
        comp.phases[step.phaseIdx].func(comp, exeModel.runArgs);
    }
}

export function resetExeModel(exeModel: IExeSystem, opts: IResetOptions) {
    for (let comp of exeModel.comps) {
        let def = exeModel.compLibrary.comps.get(comp.comp.defId)!;
        def.reset?.(comp, opts);
    }
}

export function netToString(net: IExeNet, comps: IExeComp[]) {
    let portStr = (portRef: IExePortRef) => {
        let comp = comps[portRef.compIdx];
        let port = comp.ports[portRef.portIdx];
        let tristateStr = hasFlag(port.type, PortDir.Tristate) ? '(ts)' : '';
        let portId = comp.comp.ports[portRef.portIdx].id;
        return `${comp.comp.id}.${portId}${tristateStr}`;
    };

    return `(${net.outputs.map(a => portStr(a)).join(', ')}) -> (${net.inputs.map(a => portStr(a)).join(', ')})`;
}

export function runNet(comps: IExeComp[], net: IExeNet) {

    // let isIoNet = net.inputs.some(a => net.outputs.some(b => a.exePort === b.exePort));

    if (net.tristate) {
        // need to ensure exactly 1 output is enabled
        let enabledCount = 0;
        let enabledPortValue = 0;
        for (let portRef of net.outputs) {
            let port = portRef.exePort;
            if (portRef.valid && port.ioEnabled) {
                enabledCount++;
                enabledPortValue = port.value;
            }
        }
        net.enabledCount = enabledCount;
        net.value = enabledCount === 1 ? enabledPortValue : 0;
        if (enabledCount > 1) {
            console.log('tristate', netToString(net, comps), 'has', enabledCount, 'enabled outputs');
        }
    } else {
        // has exactly 1 input
        if (net.outputs.length !== 1) {
            net.value = 0;
        } else {
            let port = net.outputs[0].exePort;
            net.value = port.value;
        }
    }

    // if (isIoNet) {
    //     console.log('reading from io net', netToString(net, comps), 'with value', net.value.toString(16), net.value);
    // }

    for (let portRef of net.inputs) {
        portRef.exePort.value = net.value;
    }

    // console.log('running net', netToString(net, comps), 'with value', net.value.toString(16), net.value);
}

export function backpropagateUnusedSignals(exeSystem: IExeSystem) {
    // this if for determining if we should render a wire as being active or not in the UI
    // e.g. if the output of a mux is not used, we want to mark its input wires as not active
    // either

    // essentially, if all output ports of a component are unused, then all input ports are also marked as unused
    // can do this for each phase to some degree.

    // not sure if we want to mess with the port.ioEnabled flags, or just have a separate flag for this
    // primarily because those flags are used in latching, say (actually, that doesn't matter)

    // OK, let's use ioEnabled, and set all inputs of a phase to false if all outputs are false
    for (let comp of exeSystem.comps) {
        for (let phase of comp.phases) {
            for (let portIdx of [...phase.readPortIdxs, ...phase.writePortIdxs]) {
                let port = comp.ports[portIdx];
                port.dataUsed = port.ioEnabled;
            }
        }
    }

    // return;

    for (let i = exeSystem.executionSteps.length - 1; i >= 0; i--) {
        let step = exeSystem.executionSteps[i];
        if (step.compIdx !== -1) {
            let comp = exeSystem.comps[step.compIdx];
            let phase = comp.phases[step.phaseIdx];

            let allOutputsUnused = phase.writePortIdxs.length > 0;
            for (let portIdx of phase.writePortIdxs) {
                let port = comp.ports[portIdx];
                if (port.dataUsed) {
                    allOutputsUnused = false;
                    break;
                }
            }
            for (let portIdx of phase.readPortIdxs) { // special case for multi-directional ports
                let port = comp.ports[portIdx];
                if ((port.type & PortDir.InOutTri) === PortDir.InOutTri && port.ioDir === IoDir.Input) {
                    allOutputsUnused = false;
                    break;
                }
            }

            if (allOutputsUnused) {
                // let writePorts = phase.writePortIdxs.map(i => comp.comp.ports[i].id);
                // let readPorts = phase.readPortIdxs.map(i => comp.comp.ports[i].id);
                // console.log('marking ports as unused', comp.comp.defId, step.phaseIdx, writePorts, ' => ', readPorts);
                for (let portIdx of phase.readPortIdxs) {
                    let port = comp.ports[portIdx];
                    port.dataUsed = false;
                }
            }


        } else if (step.netIdx !== -1) {
            let net = exeSystem.nets[step.netIdx];
            let allOutputsUnused = true;
            for (let portRef of net.inputs) {
                if (portRef.exePort.dataUsed) {
                    allOutputsUnused = false;
                    break;
                }
            }

            if (allOutputsUnused) {
                for (let portRef of net.outputs) {
                    portRef.exePort.dataUsed = false;
                }
            }
        }
    }

}
