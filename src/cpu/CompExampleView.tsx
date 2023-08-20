import React, { useEffect } from "react";
import { useEditorContext } from "./Editor";
import s from "./CompExampleView.module.scss";
import { IElfTextSection, listElfTextSections, readElfHeader } from "./ElfParser";
import { ICompDataRom } from "./comps/SimpleMemory";
import { IExeComp } from "./CpuModel";
import { runNet } from "./comps/ComponentDefs";
import { ICompDataRegFile, ICompDataSingleReg } from "./comps/Registers";

interface IExampleEntry {
    name: string;
    elfSection: IElfTextSection;
}

export const CompExampleView: React.FC = () => {
    let { editorState, setEditorState, exeModel } = useEditorContext();

    let [examples, setExamples] = React.useState<IExampleEntry[]>([]);

    useEffect(() => {
        let basePath = (process.env.BASE_URL ?? '') + '/riscv/examples/';

        async function run() {
            let resp = await fetch(basePath + 'add_tests');

            if (resp.ok) {
                let elfFile = new Uint8Array(await resp.arrayBuffer());

                let header = readElfHeader(elfFile)!;
                let sections = listElfTextSections(elfFile, header);

                let examples = sections.map(section => {
                    // name is '.text_add0', and we want 'add0'
                    return {
                        name: section.name.slice(6),
                        elfSection: section,
                    };
                });

                setExamples(examples);
            }
        }

        run();

    }, []);

    function handleEntryClick(example: IExampleEntry) {
        let romComp = exeModel.comps.find(comp => comp.comp.defId === 'rom0') as IExeComp<ICompDataRom> | undefined;
        if (romComp) {
            romComp.data.rom.set(example.elfSection.arr);
        }
        setEditorState(a => ({ ...a }));
    }

    function onStepClicked() {
        console.log('--- running execution (latching followed by steps) ---', exeModel);
        let exeSteps = exeModel.executionSteps;
        let latchSteps = exeModel.latchSteps;

        for (let i = 0; i < exeSteps.length; i++) {
            let step = exeSteps[i];
            if (step.compIdx >= 0) {
                let comp = exeModel.comps[step.compIdx];
                console.log(`running comp ${comp.comp.name} phase ${step.phaseIdx}`);
                comp.phases[step.phaseIdx].func(comp);
            } else {
                let net = exeModel.nets[step.netIdx];
                runNet(exeModel.comps, net);
            }
        }

        for (let i = 0; i < latchSteps.length; i++) {
            let step = latchSteps[i];
            let comp = exeModel.comps[step.compIdx];
            comp.phases[step.phaseIdx].func(comp);
        }

        setEditorState(a => ({ ...a }));
    }

    function findCompByDefId(defId: string) {
        return exeModel.comps.find(comp => comp.comp.defId === defId);
    }

    function onResetClicked() {
        let pcComp = findCompByDefId('reg1') as IExeComp<ICompDataSingleReg> | undefined;
        let regComp = findCompByDefId('reg32Riscv') as IExeComp<ICompDataRegFile> | undefined;

        if (pcComp && regComp) {
            pcComp.data.value = 0;
            for (let i = 0; i < regComp.data.file.length; i++) {
                regComp.data.file[i] = 0;
            }
        } else {
            console.log('could not find pc or reg comp');
        }

        setEditorState(a => ({ ...a }));
    }

    return <div className={s.exampleView}>
        <div className={s.header}>Examples</div>

        <div className={s.body}>
            {examples.map((example, idx) => {

                return <div
                    className={s.entry}
                    onClick={() => handleEntryClick(example)}
                    key={idx}
                >{example.name}</div>;
            })}
        </div>

        <div className={s.divider} />

        <div className={s.body}>
            <button onClick={onStepClicked}>Step</button>
            <button onClick={onResetClicked}>Reset</button>
        </div>

    </div>;
};
