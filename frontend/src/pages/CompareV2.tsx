/*
 * Copyright 2022 The Kubeflow Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from 'react-query';
import { ApiRunDetail } from 'src/apis/run';
import Hr from 'src/atoms/Hr';
import Separator from 'src/atoms/Separator';
import CollapseButtonSingle from 'src/components/CollapseButtonSingle';
import { QUERY_PARAMS, RoutePage } from 'src/components/Router';
import { commonCss, padding } from 'src/Css';
import { Apis } from 'src/lib/Apis';
import Buttons from 'src/lib/Buttons';
import { URLParser } from 'src/lib/URLParser';
import { errorToMessage, logger } from 'src/lib/Utils';
import { classes, stylesheet } from 'typestyle';
import {
  filterLinkedArtifactsByType,
  getArtifactTypes,
  getArtifactsFromContext,
  getEventsByExecutions,
  getExecutionsFromContext,
  getKfpV2RunContext,
  LinkedArtifact,
} from 'src/mlmd/MlmdUtils';
import { Artifact, ArtifactType, Event, Execution } from 'src/third_party/mlmd';
import { PageProps } from './Page';
import RunList from './RunList';
import { METRICS_SECTION_NAME, OVERVIEW_SECTION_NAME, PARAMS_SECTION_NAME } from './Compare';
import MD2Tabs from 'src/atoms/MD2Tabs';

const css = stylesheet({
  outputsRow: {
    marginLeft: 15,
    overflowX: 'auto',
  },
});

interface MlmdPackage {
  executions: Execution[];
  artifacts: Artifact[];
  events: Event[];
}

interface ExecutionArtifacts {
  execution: Execution;
  linkedArtifacts: LinkedArtifact[];
}

interface RunArtifacts {
  run: ApiRunDetail;
  executionArtifacts: ExecutionArtifacts[];
}

enum MetricsType {
  SCALAR_METRICS,
  CONFUSION_MATRIX,
  ROC_CURVE,
  HTML,
  MARKDOWN,
}

// Include only the runs and executions which have artifacts of the specified type.
function filterRunArtifactsByType(
  runArtifacts: RunArtifacts[],
  artifactTypes: ArtifactType[],
  metricsType: MetricsType,
): RunArtifacts[] {
  const metricsFilter =
    metricsType === MetricsType.SCALAR_METRICS
      ? 'system.Metrics'
      : metricsType === MetricsType.CONFUSION_MATRIX || metricsType === MetricsType.ROC_CURVE
      ? 'system.ClassificationMetrics'
      : metricsType === MetricsType.HTML
      ? 'system.HTML'
      : metricsType === MetricsType.MARKDOWN
      ? 'system.Markdown'
      : '';
  const typeRuns: RunArtifacts[] = [];
  for (const runArtifact of runArtifacts) {
    const typeExecutions: ExecutionArtifacts[] = [];
    for (const e of runArtifact.executionArtifacts) {
      let typeArtifacts: LinkedArtifact[] = filterLinkedArtifactsByType(
        metricsFilter,
        artifactTypes,
        e.linkedArtifacts,
      );
      if (metricsType === MetricsType.CONFUSION_MATRIX) {
        typeArtifacts = typeArtifacts.filter(x =>
          x.artifact.getCustomPropertiesMap().has('confusionMatrix'),
        );
      } else if (metricsType === MetricsType.ROC_CURVE) {
        typeArtifacts = typeArtifacts.filter(x =>
          x.artifact.getCustomPropertiesMap().has('confidenceMetrics'),
        );
      }
      if (typeArtifacts.length > 0) {
        typeExecutions.push({
          execution: e.execution,
          linkedArtifacts: typeArtifacts,
        } as ExecutionArtifacts);
      }
    }
    if (typeExecutions.length > 0) {
      typeRuns.push({
        run: runArtifact.run,
        executionArtifacts: typeExecutions,
      } as RunArtifacts);
    }
  }
  return typeRuns;
}

function getRunArtifacts(runs: ApiRunDetail[], mlmdPackages: MlmdPackage[]): RunArtifacts[] {
  return mlmdPackages.map((mlmdPackage, index) => {
    const events = mlmdPackage.events.filter(e => e.getType() === Event.Type.OUTPUT);

    // Match artifacts to executions.
    const artifactMap = new Map();
    mlmdPackage.artifacts.forEach(artifact => artifactMap.set(artifact.getId(), artifact));
    const executionArtifacts = mlmdPackage.executions.map(execution => {
      const executionEvents = events.filter(e => e.getExecutionId() === execution.getId());
      const linkedArtifacts: LinkedArtifact[] = [];
      for (const event of executionEvents) {
        const artifactId = event.getArtifactId();
        const artifact = artifactMap.get(artifactId);
        if (artifact) {
          linkedArtifacts.push({
            event,
            artifact,
          } as LinkedArtifact);
        } else {
          logger.warn(`The artifact with the following ID was not found: ${artifactId}`);
        }
      }
      return {
        execution,
        linkedArtifacts,
      } as ExecutionArtifacts;
    });
    return {
      run: runs[index],
      executionArtifacts,
    } as RunArtifacts;
  });
}

function CompareV2(props: PageProps) {
  const { updateBanner, updateToolbar } = props;

  const runlistRef = useRef<RunList>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [metricsTab, setMetricsTab] = useState(MetricsType.SCALAR_METRICS);
  const [isOverviewCollapsed, setIsOverviewCollapsed] = useState(false);
  const [isParamsCollapsed, setIsParamsCollapsed] = useState(false);
  const [isMetricsCollapsed, setIsMetricsCollapsed] = useState(false);

  const queryParamRunIds = new URLParser(props).get(QUERY_PARAMS.runlist);
  const runIds = (queryParamRunIds && queryParamRunIds.split(',')) || [];

  // Retrieves run details.
  const {
    isLoading: isLoadingRunDetails,
    isError: isErrorRunDetails,
    error: errorRunDetails,
    data: runs,
    refetch,
  } = useQuery<ApiRunDetail[], Error>(
    ['run_details', { ids: runIds }],
    () => Promise.all(runIds.map(async id => await Apis.runServiceApi.getRun(id))),
    {
      staleTime: Infinity,
    },
  );

  // Retrieves MLMD states (executions and linked artifacts) from the MLMD store.
  const {
    data: mlmdPackages,
    isLoading: isLoadingMlmdPackages,
    isError: isErrorMlmdPackages,
    error: errorMlmdPackages,
  } = useQuery<MlmdPackage[], Error>(
    ['run_artifacts', { runIds }],
    () =>
      Promise.all(
        runIds.map(async runId => {
          const context = await getKfpV2RunContext(runId);
          const executions = await getExecutionsFromContext(context);
          const artifacts = await getArtifactsFromContext(context);
          const events = await getEventsByExecutions(executions);
          return {
            executions,
            artifacts,
            events,
          } as MlmdPackage;
        }),
      ),
    {
      staleTime: Infinity,
    },
  );

  const runArtifacts = runs && mlmdPackages ? getRunArtifacts(runs, mlmdPackages) : [];

  // artifactTypes allows us to map from artifactIds to artifactTypeNames,
  // so we can identify metrics artifact provided by system.
  const {
    data: artifactTypes,
    isLoading: isLoadingArtifactTypes,
    isError: isErrorArtifactTypes,
    error: errorArtifactTypes,
  } = useQuery<ArtifactType[], Error>(['artifact_types', {}], () => getArtifactTypes(), {
    staleTime: Infinity,
  });

  // TODO(zpChris): The pending work item of displaying visualizations will need these filters.
  if (artifactTypes) {
    filterRunArtifactsByType(runArtifacts, artifactTypes, MetricsType.SCALAR_METRICS);
    filterRunArtifactsByType(runArtifacts, artifactTypes, MetricsType.CONFUSION_MATRIX);
    filterRunArtifactsByType(runArtifacts, artifactTypes, MetricsType.ROC_CURVE);
    filterRunArtifactsByType(runArtifacts, artifactTypes, MetricsType.HTML);
    filterRunArtifactsByType(runArtifacts, artifactTypes, MetricsType.MARKDOWN);
  }

  useEffect(() => {
    if (isLoadingRunDetails || isLoadingMlmdPackages || isLoadingArtifactTypes) {
      return;
    }

    if (isErrorRunDetails) {
      (async function() {
        const errorMessage = await errorToMessage(errorRunDetails);
        updateBanner({
          additionalInfo: errorMessage ? errorMessage : undefined,
          message: `Error: failed loading ${runIds.length} runs. Click Details for more information.`,
          mode: 'error',
        });
      })();
    } else if (isErrorMlmdPackages) {
      updateBanner({
        message: 'Cannot get MLMD objects from Metadata store.',
        additionalInfo: errorMlmdPackages ? errorMlmdPackages.message : undefined,
        mode: 'error',
      });
    } else if (isErrorArtifactTypes) {
      updateBanner({
        message: 'Cannot get Artifact Types for MLMD.',
        additionalInfo: errorArtifactTypes ? errorArtifactTypes.message : undefined,
        mode: 'error',
      });
    } else {
      updateBanner({});
    }
  }, [
    runIds.length,
    isLoadingRunDetails,
    isLoadingMlmdPackages,
    isLoadingArtifactTypes,
    isErrorRunDetails,
    isErrorMlmdPackages,
    isErrorArtifactTypes,
    errorRunDetails,
    errorMlmdPackages,
    errorArtifactTypes,
    updateBanner,
  ]);

  useEffect(() => {
    const refresh = async () => {
      if (runlistRef.current) {
        await runlistRef.current.refresh();
      }
      await refetch();
    };

    const buttons = new Buttons(props, refresh);
    updateToolbar({
      actions: buttons
        .expandSections(() => {
          setIsOverviewCollapsed(false);
          setIsParamsCollapsed(false);
          setIsMetricsCollapsed(false);
        })
        .collapseSections(() => {
          setIsOverviewCollapsed(true);
          setIsParamsCollapsed(true);
          setIsMetricsCollapsed(true);
        })
        .refresh(refresh)
        .getToolbarActionMap(),
      breadcrumbs: [{ displayName: 'Experiments', href: RoutePage.EXPERIMENTS }],
      pageTitle: 'Compare runs',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (runs) {
      setSelectedIds(runs.map(r => r.run!.id!));
    }
  }, [runs]);

  const showPageError = async (message: string, error: Error | undefined) => {
    const errorMessage = await errorToMessage(error);
    updateBanner({
      additionalInfo: errorMessage ? errorMessage : undefined,
      message: message + (errorMessage ? ' Click Details for more information.' : ''),
    });
  };

  const selectionChanged = (selectedIds: string[]): void => {
    setSelectedIds(selectedIds);
  };

  return (
    <div className={classes(commonCss.page, padding(20, 'lrt'))}>
      {/* Overview section */}
      <CollapseButtonSingle
        sectionName={OVERVIEW_SECTION_NAME}
        collapseSection={isOverviewCollapsed}
        collapseSectionUpdate={setIsOverviewCollapsed}
      />
      {!isOverviewCollapsed && (
        <div className={commonCss.noShrink}>
          <RunList
            onError={showPageError}
            {...props}
            selectedIds={selectedIds}
            ref={runlistRef}
            runIdListMask={runIds}
            disablePaging={true}
            onSelectionChange={selectionChanged}
          />
        </div>
      )}

      <Separator orientation='vertical' />

      {/* Parameters section */}
      <CollapseButtonSingle
        sectionName={PARAMS_SECTION_NAME}
        collapseSection={isParamsCollapsed}
        collapseSectionUpdate={setIsParamsCollapsed}
      />
      {!isParamsCollapsed && (
        <div className={classes(commonCss.noShrink, css.outputsRow)}>
          <Separator orientation='vertical' />
          <p>Parameter Section V2</p>
          <Hr />
        </div>
      )}

      {/* Metrics section */}
      <CollapseButtonSingle
        sectionName={METRICS_SECTION_NAME}
        collapseSection={isMetricsCollapsed}
        collapseSectionUpdate={setIsMetricsCollapsed}
      />
      {!isMetricsCollapsed && (
        <div className={classes(commonCss.noShrink, css.outputsRow)}>
          <Separator orientation='vertical' />
          <MD2Tabs
            tabs={['Scalar Metrics', 'Confusion Matrix', 'ROC Curve', 'HTML', 'Markdown']}
            selectedTab={metricsTab}
            onSwitch={setMetricsTab}
          />
          <div className={classes(commonCss.page, padding(20, 'lrt'))}>
            {metricsTab === MetricsType.SCALAR_METRICS && <p>This is the Scalar Metrics tab.</p>}
            {metricsTab === MetricsType.CONFUSION_MATRIX && (
              <p>This is the Confusion Matrix tab.</p>
            )}
            {metricsTab === MetricsType.ROC_CURVE && <p>This is the ROC Curve tab.</p>}
            {metricsTab === MetricsType.HTML && <p>This is the HTML tab.</p>}
            {metricsTab === MetricsType.MARKDOWN && <p>This is the Markdown tab.</p>}
          </div>
          <Hr />
        </div>
      )}

      <Separator orientation='vertical' />
    </div>
  );
}

export default CompareV2;
