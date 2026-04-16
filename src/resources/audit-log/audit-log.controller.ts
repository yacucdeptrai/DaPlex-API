import { ClassSerializerInterceptor, Controller, Get, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath
} from '@nestjs/swagger';

import { AuditLog as AuditLogEntity } from './entities';
import { AuditLogService } from './audit-log.service';
import { CursorPageAuditLogDto } from './dto';
import { CursorPaginated } from '../../common/entities';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { UserPermission } from '../../enums';
import { ErrorMessage } from '../auth';

@ApiTags('Audit Log')
@ApiExtraModels(AuditLogEntity)
@Controller()
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.ADMINISTRATOR] })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find latest audit logs (administrator only)' })
  @ApiOkResponse({ description: 'Return a list of audit logs', type: [AuditLogEntity] })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  findAll() {
    return this.auditLogService.findAll();
  }

  @Get('cursor')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.ADMINISTRATOR] })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find audit logs using cursor pagination (administrator only)' })
  @ApiOkResponse({
    description: 'Return a list of audit logs',
    schema: {
      allOf: [{ $ref: getSchemaPath(CursorPaginated) }, { properties: { results: { type: 'array', items: { $ref: getSchemaPath(AuditLogEntity) } } } }]
    }
  })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  findAllCursor(@Query() cursorPageAuditLogsDto: CursorPageAuditLogDto) {
    return this.auditLogService.findAllCursor(cursorPageAuditLogsDto);
  }

  @Get(':id')
  @UseInterceptors(ClassSerializerInterceptor)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.ADMINISTRATOR] })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find a single audit log by id (administrator only)' })
  @ApiParam({ name: 'id', type: String })
  @ApiOkResponse({ description: 'Return audit log details', type: AuditLogEntity })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The audit log could not be found', type: ErrorMessage })
  findOne(@Param('id', ParseBigIntPipe) id: bigint) {
    return this.auditLogService.findOne(id);
  }
}
